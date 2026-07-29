import { explainCheckFailure } from '../llm/failure.js';
import { isLocalLlmEnabled } from '../llm/generate.js';
import { isLlmFailureAnalysisEnabled } from '../llm/tasks.js';

export function workflowFailureAnalysisEnabled(privateState) {
  return Boolean(
    privateState?.checks?.ok === false
    && privateState?.llmFailureStatus == null
    && isLocalLlmEnabled(privateState?.settings)
    && isLlmFailureAnalysisEnabled(privateState?.settings)
    && failedCheck(privateState.checks),
  );
}

export async function runWorkflowFailureAnalysis({
  project,
  privateState,
  signal = null,
  onProgress = null,
  explainFailure = explainCheckFailure,
} = {}) {
  if (!workflowFailureAnalysisEnabled(privateState)) return null;
  const startedAt = Date.now();
  try {
    const result = await explainFailure({
      settings: privateState.settings,
      project,
      run: {
        llm: privateState.llm ?? null,
        plan: privateState.plan ?? null,
        applied: privateState.applied ?? null,
      },
      failedCheck: failedCheck(privateState.checks),
    }, {
      signal,
      onEvent: (event) => onProgress?.({
        phase: event?.phase || event?.type || 'failure_analysis',
        label: event?.label || '',
      }),
    });
    return {
      ...result,
      durationMs: Date.now() - startedAt,
      status: 'completed',
    };
  } catch (error) {
    const cancelled = error?.code === 'cancelled' || signal?.aborted === true;
    return {
      durationMs: Date.now() - startedAt,
      provider: privateState.settings.llmProvider,
      model: privateState.settings.llmModel,
      mode: privateState.settings.llmFailureAnalysis,
      status: cancelled ? 'cancelled' : 'failed',
      cancelled,
      error: cancelled ? null : String(error?.message ?? error),
    };
  }
}

export function publicWorkflowFailureAnalysis(value) {
  if (!value) return null;
  return {
    status: ['completed', 'failed', 'cancelled'].includes(value.status)
      ? value.status
      : value.cancelled ? 'cancelled' : value.error ? 'failed' : 'completed',
    text: clean(value.text, 24_000) || null,
    mode: clean(value.mode, 64) || null,
    provider: clean(value.provider, 128) || null,
    model: clean(value.model, 256) || null,
    durationMs: Number.isSafeInteger(value.durationMs) && value.durationMs >= 0
      ? value.durationMs
      : 0,
    cancelled: value.cancelled === true,
    error: clean(value.error, 2_000) || null,
  };
}

function failedCheck(checks) {
  return (checks?.results ?? []).find((item) => item?.ok === false) ?? null;
}

function clean(value, limit) {
  return String(value ?? '')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s"'`<>|]+[\\/])*[^\s"'`<>|]*/g, '[redacted-path]')
    .trim()
    .slice(0, limit);
}
