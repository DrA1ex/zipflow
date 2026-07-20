import { reviewArchiveStructure } from '../llm/archive-review.js';
import { saveLlmDiagnostics } from '../llm/diagnostics.js';
import { generateChangeDescription, isLocalLlmEnabled } from '../llm/generate.js';
import { resolveLocalLlmSession } from '../llm/session.js';
import { listProjectRuns, saveRunRecord } from '../runs/store.js';
import { buildRunAnalytics } from '../history/analytics.js';
import { displayPath } from '../utils/paths.js';
import { beginLlmProgress } from './llm-progress.js';
import { activeRunSettings } from './runtime-settings.js';
import { showArchiveSafetyReview, showPlanReview } from './run-review.js';

export function startLlmReview(controller, input) {
  const { state } = controller;
  state.llmReviewPending = true;
  const generation = ++state.llmReviewGeneration;
  state.llmReviewPromise = generateLlmSummary(controller, input)
    .then((llm) => finishLlmReview(controller, llm, generation))
    .catch((error) => finishLlmReview(controller, {
      error: error.message,
      assessment: null,
      record: { error: error.message },
    }, generation));
}

export async function skipPendingLlmReview(controller) {
  const { state } = controller;
  if (!state.llmReviewPending) return false;
  state.llmAbortController?.abort();
  state.llmReviewGeneration += 1;
  state.llmReviewPending = false;
  state.llmReviewPromise = null;
  const settings = activeRunSettings(state);
  state.run.llm = {
    cancelled: true,
    skippedByUser: true,
    provider: settings.llmProvider,
    model: settings.llmModel,
  };
  state.run = await saveRunRecord(state.run);
  controller.message('Local LLM review skipped', [
    'The deterministic plan, backup, conflict handling, and checks remain active.',
  ], 'warning');
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
  state.llmReviewPromise = null;
  if (!state.run) return llm;
  state.run.llm = llm.record;
  state.archiveSafety = {
    ...(state.archiveSafety ?? { warnings: [], acknowledged: false }),
    llm: llm.assessment ?? null,
  };
  state.run.archiveSafety = state.archiveSafety;
  state.run = await saveRunRecord(state.run);
  emitLlmResult(controller, llm, activeRunSettings(state).llmArchiveReview);
  refreshReviewAfterLlm(controller);
  controller.invalidate();
  return llm;
}

function refreshReviewAfterLlm(controller) {
  const { state } = controller;
  if (state.screen === 'plan-review') return showPlanReview(controller);
  if (state.screen === 'archive-safety') return showArchiveSafetyReview(controller);
}

async function generateLlmSummary(controller, { plan, patch, extracted }) {
  const { state } = controller;
  const settings = activeRunSettings(state);
  if (!isLocalLlmEnabled(settings)) return { record: null, assessment: null };
  if (changedCount(plan) === 0 && settings.llmArchiveReview !== 'structure') return { record: null, assessment: null };
  state.progress = { value: 5, total: 7, detail: `Streaming summary from ${settings.llmModel}` };
  controller.invalidate();
  const llmEstimate = await previousLlmEstimate(state);
  controller.message('Local LLM analysis starting', [
    `${changedCount(plan)} changed paths · delivery ${deliveryLabel(settings.llmChangeDelivery)}${settings.llmArchiveReview === 'structure' ? ' · project/archive structure guard first' : ''}${llmEstimate ? ` · historical median ${formatEstimate(llmEstimate)}` : ''}.`,
    'Adaptive delivery uses one patch when it fits and file-by-file batches when it does not. Esc cancels only this LLM step.',
  ], 'process');
  const progress = beginLlmProgress(controller, { expectedMs: llmEstimate });
  const abortController = new AbortController();
  state.llmAbortController = abortController;
  controller.invalidate();
  const startedAt = Date.now();
  try {
    progress.onEvent({ type: 'phase', phase: 'model-info', label: 'Reading the selected model context limit' });
    const session = await resolveLocalLlmSession(settings, { signal: abortController.signal });
    progress.onEvent({ type: 'model-profile', profile: session.profile });
    let structureAssessment = null;
    if (settings.llmArchiveReview === 'structure') {
      structureAssessment = await reviewArchiveStructure(
        { settings, project: state.project, workflow: state.workflow, extracted, plan },
        { onEvent: progress.onEvent, signal: abortController.signal, session },
      );
      if (structureAssessment.assessment === 'unsuitable') {
        const result = {
          summary: structureAssessment.reasons,
          commitMessage: '',
          assessment: structureAssessment.assessment,
          confidence: structureAssessment.confidence,
          reasons: structureAssessment.reasons,
          diagnostics: { structure: structureAssessment.diagnostics },
        };
        const durationMs = Date.now() - startedAt;
        const diagnosticsPath = await saveLlmDiagnostics(state.run.id, {
          status: 'completed',
          provider: settings.llmProvider,
          model: settings.llmModel,
          diagnostics: result.diagnostics,
        }).catch(() => null);
        return {
          result,
          assessment: assessmentRecord(result, 'structure'),
          diagnosticsPath,
          record: llmRecord(state, result, diagnosticsPath, durationMs),
        };
      }
    }
    const result = await generateChangeDescription(
      { settings, project: state.project, plan, patchContent: patch.content },
      { onEvent: progress.onEvent, signal: abortController.signal, session },
    );
    if (structureAssessment) {
      result.structureAssessment = structureAssessment;
      result.diagnostics = { ...(result.diagnostics ?? {}), structure: structureAssessment.diagnostics };
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
      : result.structureAssessment
        ? assessmentRecord(result.structureAssessment, 'structure')
        : null;
    return {
      result,
      assessment,
      diagnosticsPath,
      record: llmRecord(state, result, diagnosticsPath, durationMs),
    };
  } catch (error) {
    const cancelled = error.code === 'cancelled';
    const diagnosticsPath = await saveLlmDiagnostics(state.run.id, {
      status: cancelled ? 'cancelled' : 'failed',
      provider: settings.llmProvider,
      model: settings.llmModel,
      ...(cancelled ? {} : { error }),
    }).catch(() => null);
    return {
      cancelled,
      error: cancelled ? null : error.message,
      diagnosticsPath,
      assessment: null,
      record: cancelled
        ? {
          durationMs: Date.now() - startedAt,
          provider: settings.llmProvider,
          model: settings.llmModel,
          language: settings.llmLanguage,
          cancelled: true,
          diagnosticsPath,
        }
        : {
          durationMs: Date.now() - startedAt,
          provider: settings.llmProvider,
          model: settings.llmModel,
          language: settings.llmLanguage,
          error: error.message,
          diagnosticsPath,
        },
    };
  } finally {
    if (state.llmAbortController === abortController) state.llmAbortController = null;
    progress.stop();
  }
}

function emitLlmResult(controller, llm, reviewMode) {
  if (llm.result) {
    const attempt = llm.result.diagnostics?.attempts?.find((item) => typeof item.attempt === 'number');
    if (attempt?.patch?.truncated) controller.message('Local LLM input reduced safely', [
      `Estimated ${attempt.patch.originalEstimatedTokens.toLocaleString('en-US')} tokens · sent ${attempt.patch.sentEstimatedTokens.toLocaleString('en-US')}`,
      `${attempt.patch.omittedFiles} files without excerpts · ${attempt.patch.omittedHunks} hunks omitted`,
    ], 'warning', { collapsedSummary: 'Local LLM · input reduced to fit context' });
    const assessment = llm.assessment;
    if (assessment) controller.message('Local LLM archive suitability', [
      `${assessment.assessment} · ${assessment.confidence} confidence · ${assessment.mode} review`,
      ...assessment.reasons,
    ], assessment.assessment === 'suitable' ? 'success' : 'warning', {
      collapsedSummary: `Local LLM · ${assessment.assessment} · ${assessment.confidence} confidence`,
    });
    else controller.message('Local LLM archive suitability', [
      reviewMode === 'disabled'
        ? 'Not requested · Archive review is set to Summary only.'
        : 'No suitability verdict was returned; deterministic Zipflow safety checks remain active.',
    ], reviewMode === 'disabled' ? 'info' : 'warning', {
      collapsedSummary: reviewMode === 'disabled' ? 'Local LLM · summary only' : 'Local LLM · verdict unavailable',
    });
    if (llm.result.warning) controller.message('Local LLM fallback used', [llm.result.warning], 'warning', {
      collapsedSummary: 'Local LLM · fallback used',
    });
    if (llm.result.summary?.length) controller.message('Local LLM summary', llm.result.summary, 'summary', {
      collapsedSummary: `Local LLM · ${llm.result.summary.length} summary points`,
    });
  } else if (llm.cancelled) controller.message('Local LLM generation cancelled', [
    'The update continues with normal commit-message fallbacks.',
  ], 'warning', { collapsedSummary: 'Local LLM · cancelled' });
  else if (llm.error) controller.message('Local LLM summary was not generated', [
    llm.error,
    ...(llm.diagnosticsPath ? [`Diagnostics: ${displayPath(llm.diagnosticsPath)}`] : []),
    'The update can continue and project files have not been affected by this error.',
  ], 'warning', { collapsedSummary: `Local LLM · unavailable · ${llm.error}` });
}

function llmRecord(state, result, diagnosticsPath, durationMs = 0) {
  const settings = activeRunSettings(state);
  return {
    durationMs,
    provider: settings.llmProvider,
    model: settings.llmModel,
    language: settings.llmLanguage,
    summary: result.summary,
    commitMessage: result.commitMessage || null,
    warning: result.warning || null,
    assessment: result.assessment ?? result.structureAssessment?.assessment ?? null,
    confidence: result.confidence ?? result.structureAssessment?.confidence ?? null,
    reasons: result.reasons ?? result.structureAssessment?.reasons ?? null,
    diagnostics: result.diagnostics || null,
    diagnosticsPath,
    contextText: result.contextText ?? null,
    delivery: result.diagnostics?.delivery ?? null,
  };
}

function assessmentRecord(value, mode) {
  if (!value?.assessment) return null;
  return {
    mode,
    assessment: value.assessment,
    confidence: value.confidence ?? 'low',
    reasons: value.reasons ?? value.summary ?? [],
  };
}

async function previousLlmEstimate(state) {
  const runs = (await listProjectRuns(state.project.root, { limit: 40 })).filter((run) => run.id !== state.run.id);
  const analytics = buildRunAnalytics(runs);
  const settings = activeRunSettings(state);
  const sameModel = analytics.llm.byModel.find((item) => item.name === `${settings.llmProvider} · ${settings.llmModel}`);
  return sameModel?.medianMs || analytics.llm.total.medianMs || 0;
}

function deliveryLabel(value) {
  if (value === 'patch') return 'full patch';
  if (value === 'change-list') return 'changed paths only';
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
