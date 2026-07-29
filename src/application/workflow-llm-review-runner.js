import { readFile } from 'node:fs/promises';
import {
  reviewArchiveSample,
  reviewArchiveStructure,
  reviewSnapshotDeletionIntent,
} from '../llm/archive-review.js';
import { saveLlmDiagnostics } from '../llm/diagnostics.js';
import { generateChangeDescription, isLocalLlmEnabled } from '../llm/generate.js';
import { resolveLocalLlmSession } from '../llm/session.js';
import { hasLlmChangeTasks, llmTasks } from '../llm/tasks.js';

export function workflowLlmReviewEnabled(privateState) {
  const settings = privateState?.settings;
  return Boolean(
    privateState?.plan
    && privateState?.extracted
    && isLocalLlmEnabled(settings)
    && hasLlmChangeTasks(settings)
    && changedCount(privateState.plan) > 0,
  );
}

export async function runWorkflowLlmReview({
  runId,
  project,
  privateState,
  signal = null,
  onProgress = null,
  resolveSession = resolveLocalLlmSession,
  reviewStructure = reviewArchiveStructure,
  reviewSample = reviewArchiveSample,
  reviewDeletionIntent = reviewSnapshotDeletionIntent,
  generateDescription = generateChangeDescription,
  saveDiagnostics = saveLlmDiagnostics,
} = {}) {
  if (!workflowLlmReviewEnabled(privateState)) {
    return { record: null, assessment: null, deletionIntent: null };
  }
  const settings = privateState.settings;
  const workflow = privateState.workflow;
  const plan = privateState.plan;
  const extracted = privateState.extracted;
  const tasks = llmTasks(settings);
  const reviewMode = tasks.archiveReview ? settings.llmArchiveReview : 'disabled';
  const patchContent = privateState.patch?.path
    ? await readFile(privateState.patch.path, 'utf8')
    : '';
  const deletionIntentApplicable = tasks.deletionIntentReview
    && workflow?.archive?.mode === 'snapshot'
    && (plan.deleted?.length ?? 0) > 0
    && (privateState.safety?.warnings ?? []).some(({ id }) => id === 'possible-patch-archive');
  const startedAt = Date.now();
  const notify = (event) => onProgress?.(safeProgress(event));

  try {
    notify({ type: 'phase', phase: 'model-info', label: 'Reading the selected model context limit' });
    const session = await resolveSession(settings, { signal });
    notify({ type: 'model-profile', profile: session.profile });
    let guardAssessment = null;
    let guardMode = null;
    if (reviewMode === 'structure') {
      guardMode = 'structure';
      guardAssessment = await reviewStructure(
        { settings, project, workflow, extracted, plan },
        { onEvent: notify, signal, session },
      );
    } else if (reviewMode === 'sample') {
      guardMode = 'sample';
      guardAssessment = await reviewSample(
        { settings, project, workflow, extracted, plan, patchContent },
        { onEvent: notify, signal, session },
      );
    }

    let deletionIntent = null;
    if (deletionIntentApplicable) {
      deletionIntent = await reviewDeletionIntent(
        { settings, project, workflow, extracted, plan, patchContent },
        { onEvent: notify, signal, session },
      );
    }

    const needsDescription = tasks.summary || tasks.commitMessage || reviewMode === 'patch';
    let result;
    if (guardAssessment?.assessment === 'unsuitable') {
      result = {
        summary: tasks.summary ? guardAssessment.reasons : [],
        commitMessage: '',
        assessment: guardAssessment.assessment,
        confidence: guardAssessment.confidence,
        reasons: guardAssessment.reasons,
        diagnostics: { [guardMode]: guardAssessment.diagnostics },
      };
    } else if (needsDescription) {
      result = await generateDescription({
        settings: guardAssessment ? { ...settings, llmUseArchiveReview: false } : settings,
        project,
        plan,
        patchContent,
      }, { onEvent: notify, signal, session });
    } else {
      result = { summary: [], commitMessage: '', diagnostics: {} };
    }
    if (guardAssessment) {
      result.guardAssessment = guardAssessment;
      result.diagnostics = { ...(result.diagnostics ?? {}), [guardMode]: guardAssessment.diagnostics };
    }
    if (deletionIntent) {
      result.deletionIntent = deletionIntent;
      result.diagnostics = {
        ...(result.diagnostics ?? {}),
        deletionIntent: deletionIntent.diagnostics,
      };
    }
    const diagnosticsPath = await saveDiagnostics(runId, {
      status: 'completed',
      provider: settings.llmProvider,
      model: settings.llmModel,
      diagnostics: result.diagnostics ?? null,
      raw: result.raw ?? null,
    }).catch(() => null);
    const assessment = result.assessment
      ? assessmentRecord(result, 'patch')
      : guardAssessment
        ? assessmentRecord(guardAssessment, guardMode)
        : null;
    return {
      result,
      assessment,
      deletionIntent: deletionIntent ? deletionIntentRecord(deletionIntent) : null,
      record: llmRecord(settings, tasks, result, diagnosticsPath, Date.now() - startedAt),
    };
  } catch (error) {
    const cancelled = error?.code === 'cancelled' || signal?.aborted === true;
    const diagnosticsPath = await saveDiagnostics(runId, {
      status: cancelled ? 'cancelled' : 'failed',
      provider: settings.llmProvider,
      model: settings.llmModel,
      ...(cancelled ? {} : { error }),
    }).catch(() => null);
    return {
      result: null,
      assessment: null,
      deletionIntent: null,
      record: {
        durationMs: Date.now() - startedAt,
        provider: settings.llmProvider,
        model: settings.llmModel,
        language: settings.llmSummaryLanguage || settings.llmLanguage,
        tasks,
        ...(cancelled ? { cancelled: true } : { error: String(error?.message ?? error) }),
        diagnosticsPath,
      },
    };
  }
}

export function publicWorkflowLlmReview(record, assessment, deletionIntent) {
  if (!record) return null;
  return {
    status: record.cancelled ? 'cancelled' : record.error ? 'failed' : 'completed',
    provider: clean(record.provider, 128),
    model: clean(record.model, 256),
    durationMs: finite(record.durationMs),
    summary: boundedStrings(record.summary, 5, 2_000),
    commitMessage: clean(record.commitMessage, 4_096) || null,
    warning: clean(record.warning, 2_000) || null,
    assessment: assessment ? publicAssessment(assessment) : null,
    deletionIntent: deletionIntent ? {
      assessment: clean(deletionIntent.assessment, 64),
      confidence: clean(deletionIntent.confidence, 64),
      reasons: boundedStrings(deletionIntent.reasons, 5, 2_000),
    } : null,
    error: record.error ? clean(record.error, 2_000) : null,
  };
}

function llmRecord(settings, tasks, result, diagnosticsPath, durationMs) {
  return {
    durationMs,
    provider: settings.llmProvider,
    model: settings.llmModel,
    language: settings.llmSummaryLanguage || settings.llmLanguage,
    languages: {
      prompt: settings.llmPromptLanguage || 'English',
      summary: settings.llmSummaryLanguage || settings.llmLanguage || 'English',
      commit: settings.llmCommitLanguage || settings.llmLanguage || 'English',
    },
    tasks,
    summary: tasks.summary ? boundedStrings(result.summary, 5, 8_000) : [],
    commitMessage: tasks.commitMessage ? clean(result.commitMessage, 4_096) || null : null,
    warning: clean(result.warning, 2_000) || null,
    assessment: result.assessment ?? result.guardAssessment?.assessment ?? null,
    confidence: result.confidence ?? result.guardAssessment?.confidence ?? null,
    reasons: boundedStrings(result.reasons ?? result.guardAssessment?.reasons, 5, 4_000),
    diagnostics: result.diagnostics ?? null,
    diagnosticsPath,
    contextText: clean(result.contextText, 70_000) || null,
    delivery: result.diagnostics?.delivery ?? null,
    deletionIntent: result.deletionIntent ? deletionIntentRecord(result.deletionIntent) : null,
  };
}

function assessmentRecord(value, mode) {
  if (!value?.assessment) return null;
  return {
    mode,
    assessment: value.assessment,
    confidence: value.confidence ?? 'low',
    reasons: boundedStrings(value.reasons ?? value.summary, 5, 4_000),
    recommendation: value.recommendation
      ?? (value.assessment === 'unsuitable'
        ? 'cancel-update'
        : value.assessment === 'suitable' ? 'continue' : 'manual-review'),
    ...(value.projectRelation ? { projectRelation: value.projectRelation } : {}),
    ...(value.archiveShape ? { archiveShape: value.archiveShape } : {}),
  };
}

function deletionIntentRecord(value) {
  if (!value?.assessment) return null;
  return {
    assessment: value.assessment,
    confidence: value.confidence ?? 'low',
    reasons: boundedStrings(value.reasons, 5, 4_000),
  };
}

function publicAssessment(value) {
  return {
    mode: clean(value.mode, 64),
    assessment: clean(value.assessment, 64),
    confidence: clean(value.confidence, 64),
    reasons: boundedStrings(value.reasons, 5, 2_000),
    recommendation: clean(value.recommendation, 64),
    ...(value.projectRelation ? { projectRelation: clean(value.projectRelation, 64) } : {}),
    ...(value.archiveShape ? { archiveShape: clean(value.archiveShape, 64) } : {}),
  };
}

function safeProgress(event) {
  return {
    type: clean(event?.type, 64),
    phase: clean(event?.phase, 128),
    label: clean(event?.label, 512),
    ...(Number.isSafeInteger(event?.index) ? { index: event.index } : {}),
    ...(Number.isSafeInteger(event?.total) ? { total: event.total } : {}),
  };
}

function changedCount(plan) {
  return (plan?.created?.length ?? 0) + (plan?.updated?.length ?? 0) + (plan?.deleted?.length ?? 0);
}

function boundedStrings(values, limit, charLimit) {
  return (Array.isArray(values) ? values : [])
    .map((value) => clean(value, charLimit))
    .filter(Boolean)
    .slice(0, limit);
}

function clean(value, limit) {
  return String(value ?? '')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s"'`<>|]+[\\/])*[^\s"'`<>|]*/g, '[redacted-path]')
    .trim()
    .slice(0, limit);
}

function finite(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}
