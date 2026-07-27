import { reviewArchiveSample, reviewArchiveStructure, reviewSnapshotDeletionIntent } from '../llm/archive-review.js';
import { saveLlmDiagnostics } from '../llm/diagnostics.js';
import { generateChangeDescription, isLocalLlmEnabled } from '../llm/generate.js';
import { resolveLocalLlmSession } from '../llm/session.js';
import { listProjectRuns, saveRunRecord } from '../runs/store.js';
import { buildRunAnalytics } from '../history/analytics.js';
import { displayPath } from '../utils/paths.js';
import { hasLlmChangeTasks, llmTasks } from '../llm/tasks.js';
import { beginLlmProgress } from './llm-progress.js';
import { activeRunSettings } from './runtime-settings.js';
import { showArchiveSafetyReview, showPlanReview } from './run-review.js';
import { activeArchiveMode, activeArchiveWorkflow } from './archive-interpretation.js';

export function startLlmReview(controller, input) {
  const { state } = controller;
  const operation = controller.beginOperation({ kind: 'llm-review', label: 'Generating local LLM review' });
  state.llmReviewInput = input;
  state.llmReviewPending = true;
  state.llmReviewCancelling = false;
  state.llmAbortController = { abort: () => operation.abort() };
  const generation = ++state.llmReviewGeneration;
  state.llmReviewPromise = generateLlmSummary(controller, input, operation)
    .then((llm) => finishLlmReview(controller, llm, generation))
    .catch((error) => {
      const deletionOnly = input.taskOverride === 'deletion-intent';
      return finishLlmReview(controller, {
        error: error.message,
        ...(deletionOnly ? {} : { assessment: null }),
        record: {
          error: error.message,
          ...(deletionOnly ? { taskOverride: 'deletion-intent' } : {}),
        },
      }, generation);
    });
  return state.llmReviewPromise;
}

export async function cancelPendingLlmReview(controller, { skippedByUser = false } = {}) {
  const { state } = controller;
  if (!state.llmReviewPending && state.activeOperation?.kind !== 'llm-review') return false;
  if (state.llmReviewCancelling) {
    await state.llmReviewPromise;
    return true;
  }
  state.llmReviewCancelling = true;
  state.llmReviewSkippedByUser = Boolean(skippedByUser);
  if (state.llmRuntime) {
    state.llmRuntime.cancellationRequested = true;
    state.llmRuntime.phase = 'cancelling';
    state.llmRuntime.label = 'Cancelling local LLM generation';
  }
  const pendingReview = state.llmReviewPromise;
  controller.setStatus('Cancelling local LLM generation…');
  state.llmAbortController?.abort();
  await pendingReview;
  return true;
}

export const skipPendingLlmReview = cancelPendingLlmReview;

export function restartLlmReview(controller) {
  const { state } = controller;
  if (state.llmReviewPending || !state.llmReviewInput) return false;
  startLlmReview(controller, state.llmReviewInput);
  showPlanReview(controller);
  return true;
}

export function startDeletionIntentReview(controller) {
  const { state } = controller;
  if (state.llmReviewPending || state.activeOperation?.kind === 'llm-review') return false;
  if (!state.plan?.deleted?.length || activeArchiveMode(state) !== 'snapshot') {
    controller.toast('No snapshot deletions to review', 'info', 3, 'Recheck the archive as a full snapshot first.');
    return showPlanReview(controller);
  }
  startLlmReview(controller, {
    plan: state.plan,
    patch: state.llmReviewInput?.patch ?? { path: state.run?.patch?.path ?? null, content: '', omitted: state.run?.patch?.omitted ?? 0 },
    extracted: state.archive,
    taskOverride: 'deletion-intent',
  });
  showPlanReview(controller);
  return true;
}

export async function waitForPendingLlmReview(controllerOrState) {
  const state = controllerOrState?.state ?? controllerOrState;
  if (!state?.llmReviewPromise) return null;
  return state.llmReviewPromise;
}

async function finishLlmReview(controller, llm, generation) {
  const { state } = controller;
  if (generation !== state.llmReviewGeneration) return llm;
  state.llmReviewPending = false;
  state.llmReviewCancelling = false;
  state.llmReviewPromise = null;
  const skippedByUser = state.llmReviewSkippedByUser;
  state.llmReviewSkippedByUser = false;
  if (!state.run) return llm;
  if (llm.record?.taskOverride === 'deletion-intent') {
    state.run.llm = {
      ...(state.run.llm ?? {}),
      ...(llm.record.deletionIntent ? { deletionIntent: llm.record.deletionIntent } : {}),
      deletionIntentReview: {
        durationMs: llm.record.durationMs,
        diagnosticsPath: llm.record.diagnosticsPath,
        provider: llm.record.provider,
        model: llm.record.model,
        error: llm.record.error ?? null,
        cancelled: llm.record.cancelled === true,
      },
      ...(skippedByUser ? { skippedByUser: true } : {}),
    };
  } else {
    state.run.llm = llm.record ? { ...llm.record, ...(skippedByUser ? { skippedByUser: true } : {}) } : llm.record;
  }
  state.archiveSafety = {
    ...(state.archiveSafety ?? { warnings: [], acknowledged: false }),
    ...(llm.assessment !== undefined ? { llm: llm.assessment ?? null } : {}),
    ...(llm.deletionIntent !== undefined ? { deletionIntent: llm.deletionIntent ?? null } : {}),
    ...(['ambiguous', 'likely-partial'].includes(llm.deletionIntent?.assessment) ? { acknowledged: false } : {}),
  };
  state.run.archiveSafety = state.archiveSafety;
  state.run = await saveRunRecord(state.run);
  emitLlmResult(controller, llm, activeRunSettings(state));
  refreshReviewAfterLlm(controller);
  controller.invalidate();
  return llm;
}

function refreshReviewAfterLlm(controller) {
  const { state } = controller;
  if (state.screen === 'plan-review') return showPlanReview(controller);
  if (state.screen === 'archive-safety') return showArchiveSafetyReview(controller);
}

async function generateLlmSummary(controller, { plan, patch, extracted, taskOverride = null }, operation) {
  const { state } = controller;
  const settings = activeRunSettings(state);
  const configuredTasks = llmTasks(settings);
  const tasks = taskOverride === 'deletion-intent'
    ? { archiveReview: false, deletionIntentReview: true, summary: false, failedChecks: false, commitMessage: false, dirtyTreeCommitMessage: false }
    : configuredTasks;
  const reviewMode = tasks.archiveReview ? settings.llmArchiveReview : 'disabled';
  const deletionIntentApplicable = tasks.deletionIntentReview
    && activeArchiveMode(state) === 'snapshot'
    && plan.deleted.length > 0
    && (taskOverride === 'deletion-intent'
      || state.archiveSafety?.warnings?.some((warning) => warning.id === 'possible-patch-archive'));
  if (!isLocalLlmEnabled(settings) || (!taskOverride && !hasLlmChangeTasks(settings))) return { record: null, assessment: null };
  if (!tasks.archiveReview && !tasks.summary && !tasks.commitMessage && !deletionIntentApplicable) return { record: null, assessment: null };
  if (changedCount(plan) === 0 && !['structure', 'sample'].includes(reviewMode)) return { record: null, assessment: null };
  state.progress = { value: 5, total: 7, detail: `Streaming requested LLM output from ${settings.llmModel}` };
  controller.invalidate();
  const llmEstimate = await previousLlmEstimate(state);
  controller.message('Local LLM analysis starting', [
    `Projects: ${projectContextLabel(state.project)}`,
    `${changedCount(plan)} changed paths · tasks ${taskLabel(tasks)} · delivery ${deliveryLabel(settings.llmChangeDelivery)}${reviewMode === 'structure' ? ' · project/archive structure guard first' : reviewMode === 'sample' ? ' · bounded structure and patch sample guard first' : ''}${llmEstimate ? ` · historical median ${formatEstimate(llmEstimate)}` : ''}.`,
    'Adaptive delivery uses a full patch, representative sample, or capped batches according to the model context. Ctrl+C cancels this LLM operation.',
  ], 'process');
  const progress = beginLlmProgress(controller, { expectedMs: llmEstimate });
  controller.invalidate();
  const startedAt = Date.now();
  let operationOutcome = 'completed';
  try {
    progress.onEvent({ type: 'phase', phase: 'model-info', label: 'Reading the selected model context limit' });
    const session = await resolveLocalLlmSession(settings, { signal: operation.signal });
    progress.onEvent({ type: 'model-profile', profile: session.profile });
    let guardAssessment = null;
    let guardMode = null;
    if (reviewMode === 'structure') {
      guardMode = 'structure';
      guardAssessment = await reviewArchiveStructure(
        { settings, project: state.project, workflow: activeArchiveWorkflow(state), extracted, plan },
        { onEvent: progress.onEvent, signal: operation.signal, session },
      );
    } else if (reviewMode === 'sample') {
      guardMode = 'sample';
      guardAssessment = await reviewArchiveSample(
        { settings, project: state.project, workflow: activeArchiveWorkflow(state), extracted, plan, patchContent: patch.content },
        { onEvent: progress.onEvent, signal: operation.signal, session },
      );
    }
    if (guardAssessment?.assessment === 'unsuitable') {
      const result = {
        summary: tasks.summary ? guardAssessment.reasons : [],
        commitMessage: '',
        assessment: guardAssessment.assessment,
        confidence: guardAssessment.confidence,
        reasons: guardAssessment.reasons,
        diagnostics: { [guardMode]: guardAssessment.diagnostics },
      };
      const durationMs = Date.now() - startedAt;
      const diagnosticsPath = await saveLlmDiagnostics(state.run.id, {
        status: 'completed', provider: settings.llmProvider, model: settings.llmModel, diagnostics: result.diagnostics,
      }).catch(() => null);
      return {
        result, assessment: assessmentRecord(result, guardMode), diagnosticsPath,
        record: llmRecord(state, result, diagnosticsPath, durationMs, tasks),
      };
    }
    const shouldReviewDeletionIntent = deletionIntentApplicable;
    let deletionIntent = null;
    if (shouldReviewDeletionIntent) {
      deletionIntent = await reviewSnapshotDeletionIntent(
        { settings, project: state.project, workflow: activeArchiveWorkflow(state), extracted, plan, patchContent: patch.content },
        { onEvent: progress.onEvent, signal: operation.signal, session },
      );
    }

    const needsDescription = tasks.summary || tasks.commitMessage || reviewMode === 'patch';
    const descriptionSettings = guardAssessment
      ? { ...settings, llmUseArchiveReview: false }
      : settings;
    const result = needsDescription
      ? await generateChangeDescription(
        { settings: descriptionSettings, project: state.project, plan, patchContent: patch.content },
        { onEvent: progress.onEvent, signal: operation.signal, session },
      )
      : { summary: [], commitMessage: '', diagnostics: {} };
    if (guardAssessment) {
      result.guardAssessment = guardAssessment;
      result.diagnostics = { ...(result.diagnostics ?? {}), [guardMode]: guardAssessment.diagnostics };
    }
    if (taskOverride) result.taskOverride = taskOverride;
    if (deletionIntent) {
      result.deletionIntent = deletionIntent;
      result.diagnostics = { ...(result.diagnostics ?? {}), deletionIntent: deletionIntent.diagnostics };
    }
    const durationMs = Date.now() - startedAt;
    const diagnosticsPath = await saveLlmDiagnostics(state.run.id, {
      status: 'completed',
      provider: settings.llmProvider,
      model: settings.llmModel,
      diagnostics: result.diagnostics ?? null,
      raw: result.raw ?? null,
    }).catch(() => null);
    const assessment = result.assessment
      ? assessmentRecord(result, 'patch')
      : result.guardAssessment
        ? assessmentRecord(result.guardAssessment, guardMode)
        : null;
    return {
      result,
      assessment,
      deletionIntent: deletionIntent ? deletionIntentRecord(deletionIntent) : undefined,
      diagnosticsPath,
      record: llmRecord(state, result, diagnosticsPath, durationMs, tasks),
    };
  } catch (error) {
    const cancelled = error.code === 'cancelled';
    operationOutcome = cancelled ? 'cancelled' : 'failed';
    const diagnosticsPath = await saveLlmDiagnostics(state.run.id, {
      status: cancelled ? 'cancelled' : 'failed',
      provider: settings.llmProvider,
      model: settings.llmModel,
      ...(cancelled ? {} : { error }),
    }).catch(() => null);
    const deletionOnly = taskOverride === 'deletion-intent';
    const record = {
      durationMs: Date.now() - startedAt,
      provider: settings.llmProvider,
      model: settings.llmModel,
      language: settings.llmSummaryLanguage || settings.llmLanguage,
      languages: llmLanguages(settings),
      ...(deletionOnly ? { taskOverride: 'deletion-intent' } : {}),
      ...(cancelled ? { cancelled: true } : { error: error.message }),
      diagnosticsPath,
    };
    return {
      cancelled,
      error: cancelled ? null : error.message,
      diagnosticsPath,
      ...(deletionOnly ? {} : { assessment: null }),
      record,
    };
  } finally {
    state.llmAbortController = null;
    progress.stop();
    operation.finish(operationOutcome);
  }
}


function projectContextLabel(project) {
  const entries = project.activeProjects ?? project.projects?.filter((entry) => entry.selected !== false) ?? [];
  if (!entries.length) return 'Workspace root';
  return entries.map((entry) => entry.path === '.' ? 'Root' : `${entry.path}/`).join(', ');
}

function emitLlmResult(controller, llm, settings) {
  const tasks = llm.result?.taskOverride === 'deletion-intent'
    ? { ...llmTasks(settings), archiveReview: false, summary: false, commitMessage: false, deletionIntentReview: true }
    : llmTasks(settings);
  const reviewMode = tasks.archiveReview ? settings.llmArchiveReview : 'disabled';
  if (llm.result) {
    const attempt = llm.result.diagnostics?.attempts?.find((item) => typeof item.attempt === 'number');
    if (attempt?.patch?.truncated) controller.message('Additional LLM context reduction', [
      `Estimated ${attempt.patch.originalEstimatedTokens.toLocaleString('en-US')} tokens · sent ${attempt.patch.sentEstimatedTokens.toLocaleString('en-US')}`,
      `${attempt.patch.omittedFiles} file${attempt.patch.omittedFiles === 1 ? '' : 's'} without excerpts · ${attempt.patch.omittedHunks} hunk${attempt.patch.omittedHunks === 1 ? '' : 's'} omitted`,
    ], 'warning', { collapsedSummary: 'Local LLM · additional context reduction' });
    const assessment = llm.assessment;
    if (tasks.archiveReview && assessment) {
      const reasons = cleanAssessmentReasons(assessment.reasons);
      controller.message('Local LLM archive suitability', [
        `Assessment: ${titleCase(assessment.assessment)}`,
        `Confidence: ${titleCase(assessment.confidence)}`,
        `Review: ${reviewModeLabel(assessment.mode)}`,
        ...(reasons.length ? ['Reasons:', ...reasons.map((reason) => `• ${reason}`)] : []),
      ], assessment.assessment === 'suitable' ? 'success' : 'warning', {
        collapsedSummary: `Local LLM · ${assessment.assessment} · ${assessment.confidence} confidence`,
      });
    } else if (tasks.archiveReview) controller.message('Local LLM archive suitability', [
      'No suitability verdict was returned; deterministic Zipflow safety checks remain active.',
    ], 'warning', { collapsedSummary: 'Local LLM · verdict unavailable' });
    if (llm.deletionIntent) {
      const reasons = cleanAssessmentReasons(llm.deletionIntent.reasons);
      controller.message('Local LLM snapshot deletion intent', [
        `Assessment: ${deletionIntentLabel(llm.deletionIntent.assessment)}`,
        `Confidence: ${titleCase(llm.deletionIntent.confidence)}`,
        ...(reasons.length ? ['Reasons:', ...reasons.map((reason) => `• ${reason}`)] : []),
      ], llm.deletionIntent.assessment === 'intentional' ? 'success' : 'warning', {
        collapsedSummary: `Local LLM · deletions ${llm.deletionIntent.assessment} · ${llm.deletionIntent.confidence} confidence`,
      });
    }

    if (llm.result.warning) controller.message('Local LLM fallback used', [llm.result.warning], 'warning', {
      collapsedSummary: 'Local LLM · fallback used',
    });
    const delivery = llm.result.diagnostics?.delivery;
    const coverage = delivery?.coverage ?? llm.result.diagnostics?.sample?.coverage;
    if (delivery?.resolved || coverage) controller.message('Local LLM review coverage', [
      ...(delivery?.resolved ? [`Delivery: ${deliveryLabel(delivery.resolved)}${delivery.batches ? ` · ${delivery.batches} batches` : ''}`] : ['Delivery: archive sample guard']),
      ...(coverage ? [
        `Reviewed content: ${coverage.reviewedFiles} of ${coverage.totalFiles} changed files`,
        `Changed-path manifest: ${coverage.manifestFiles} of ${coverage.totalFiles} files`,
        `Patch coverage: ${coverage.patchCoveragePercent}% · ${coverage.omittedFiles} files omitted`,
      ] : []),
    ], 'info', {
      collapsible: false,
      collapsedSummary: coverage
        ? `Local LLM · ${coverage.reviewedFiles}/${coverage.totalFiles} files with content`
        : `Local LLM · ${deliveryLabel(delivery.resolved)}`,
    });
    if (tasks.summary && llm.result.summary?.length) controller.message('Local LLM summary', llm.result.summary, 'summary', {
      collapsedSummary: `Local LLM · ${llm.result.summary.length} summary points`,
    });
  } else if (llm.cancelled) controller.message('Local LLM generation cancelled', [
    'The update continues without the cancelled model output.',
  ], 'warning', { collapsedSummary: 'Local LLM · cancelled' });
  else if (llm.error) controller.message('Requested Local LLM output was not generated', [
    llm.error,
    ...(llm.diagnosticsPath ? [`Diagnostics: ${displayPath(llm.diagnosticsPath)}`] : []),
    'The update can continue and project files have not been affected by this error.',
  ], 'warning', { collapsedSummary: `Local LLM · unavailable · ${llm.error}` });
}


function titleCase(value) {
  const text = String(value ?? '').trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : 'Unknown';
}

function reviewModeLabel(value) {
  if (value === 'structure') return 'Structure guard';
  if (value === 'sample') return 'Sample guard';
  if (value === 'patch') return 'Deep patch review';
  return titleCase(value);
}

function llmRecord(state, result, diagnosticsPath, durationMs = 0, tasks = llmTasks(activeRunSettings(state))) {
  const settings = activeRunSettings(state);
  return {
    durationMs,
    provider: settings.llmProvider,
    model: settings.llmModel,
    language: settings.llmSummaryLanguage || settings.llmLanguage,
    languages: llmLanguages(settings),
    tasks,
    taskOverride: result.taskOverride ?? null,
    summary: tasks.summary ? result.summary : [],
    commitMessage: tasks.commitMessage ? result.commitMessage || null : null,
    warning: result.warning || null,
    assessment: result.assessment ?? result.structureAssessment?.assessment ?? null,
    confidence: result.confidence ?? result.structureAssessment?.confidence ?? null,
    reasons: cleanAssessmentReasons(result.reasons ?? result.structureAssessment?.reasons ?? []),
    diagnostics: result.diagnostics || null,
    diagnosticsPath,
    contextText: result.contextText ?? null,
    delivery: result.diagnostics?.delivery ?? null,
    deletionIntent: result.deletionIntent ? deletionIntentRecord(result.deletionIntent) : null,
  };
}

function llmLanguages(settings) {
  return {
    prompt: settings.llmPromptLanguage || 'English',
    summary: settings.llmSummaryLanguage || settings.llmLanguage || 'English',
    commit: settings.llmCommitLanguage || settings.llmLanguage || 'English',
  };
}

function assessmentRecord(value, mode) {
  if (!value?.assessment) return null;
  return {
    mode,
    assessment: value.assessment,
    confidence: value.confidence ?? 'low',
    reasons: cleanAssessmentReasons(value.reasons ?? value.summary ?? []),
  };
}

function deletionIntentRecord(value) {
  if (!value?.assessment) return null;
  return {
    assessment: value.assessment,
    confidence: value.confidence ?? 'low',
    reasons: cleanAssessmentReasons(value.reasons ?? []),
  };
}

function deletionIntentLabel(value) {
  if (value === 'likely-partial') return 'Likely partial archive';
  if (value === 'intentional') return 'Removals look intentional';
  return 'Ambiguous';
}

function cleanAssessmentReasons(values) {
  const seen = new Set();
  const result = [];
  for (const value of values ?? []) {
    const text = String(value ?? '').trim()
      .replace(/^reason\s*:\s*/i, '')
      .replace(/^[-*•]\s+/, '')
      .trim();
    if (!text) continue;
    if (/^\[(?:list|reasons?|bullet points?)(?:\s+in\s+[^\]]+)?\]$/i.test(text)) continue;
    if (/^(?:reviewing|checking|comparing|inspecting)\b.*:?$/i.test(text)) continue;
    if (/^i\s+(?:need|will|should|must|am going)\s+to\s+(?:check|review|compare|inspect)\b/i.test(text)) continue;
    if (/^(?:let me|let's)\s+(?:check|review|compare|inspect)\b/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= 5) break;
  }
  return result;
}

async function previousLlmEstimate(state) {
  const runs = (await listProjectRuns(state.project.root, { limit: 40 })).filter((run) => run.id !== state.run.id);
  const analytics = buildRunAnalytics(runs);
  const settings = activeRunSettings(state);
  const sameModel = analytics.llm.byModel.find((item) => item.name === `${settings.llmProvider} · ${settings.llmModel}`);
  return sameModel?.medianMs || analytics.llm.total.medianMs || 0;
}

function taskLabel(tasks) {
  return [
    tasks.archiveReview ? 'archive review' : null,
    tasks.deletionIntentReview ? 'snapshot deletion intent' : null,
    tasks.summary ? 'summary' : null,
    tasks.commitMessage ? 'commit message' : null,
  ].filter(Boolean).join(', ');
}

function deliveryLabel(value) {
  if (value === 'patch') return 'full patch';
  if (value === 'change-list') return 'changed paths only';
  if (value === 'representative') return 'representative sample';
  if (value === 'capped') return 'capped batches';
  if (value === 'chunked') return 'file-by-file chunks';
  return 'adaptive';
}

function formatEstimate(milliseconds) {
  if (milliseconds >= 60_000) return `${Math.max(1, Math.round(milliseconds / 60_000))} min`;
  return `${Math.max(1, Math.round(milliseconds / 1000))} sec`;
}

function changedCount(plan) {
  return plan.created.length + plan.updated.length + plan.deleted.length;
}
