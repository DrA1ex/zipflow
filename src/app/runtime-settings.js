import { llmTasks } from '../llm/tasks.js';

const RUN_SETTING_KEYS = Object.freeze([
  'checkOutput',
  'llmProvider',
  'llmModel',
  'llmLanguage',
  'llmPromptLanguage',
  'llmSummaryLanguage',
  'llmCommitLanguage',
  'llmSelectedInstanceId',
  'llmApiToken',
  'llmUseArchiveReview',
  'llmUseSummary',
  'llmUseFailedChecks',
  'llmUseCommitMessage',
  'llmArchiveReview',
  'llmChangeDelivery',
  'llmFailureAnalysis',
  'llmVerboseOutput',
  'llmModelLoadConfigs',
  'archivePolicy',
  'archiveDirectory',
  'archiveRetentionDays',
  'archiveMaxBytes',
  'backupRetentionPolicy',
  'backupRetentionDays',
  'backupMaxBytes',
  'managedHistoryPolicy',
]);

export function captureRunSettings(state) {
  const source = state.settings ?? {};
  const snapshot = {};
  for (const key of RUN_SETTING_KEYS) snapshot[key] = structuredClone(source[key]);
  state.runSettings = Object.freeze(snapshot);
  if (state.run) state.run.settings = sanitizeRunSettings(snapshot);
  return state.runSettings;
}

export function activeRunSettings(state) {
  return state.runSettings ?? state.settings;
}

export function clearRunSettings(state) {
  state.runSettings = null;
}

export function hasActiveRunSettings(state) {
  return Boolean(state.runSettings && state.run && !['completed', 'failed', 'cancelled', 'rolled_back'].includes(state.run.status));
}

export function runSettingsStatus(state) {
  if (!hasActiveRunSettings(state)) return '';
  const settings = state.runSettings;
  const provider = settings.llmProvider === 'disabled'
    ? 'LLM off'
    : `${providerLabel(settings.llmProvider)}/${settings.llmModel || 'no model'}`;
  return `Current ${provider} · ${compactTaskLabel(settings)} · edits → next run`;
}

function sanitizeRunSettings(settings) {
  const result = structuredClone(settings);
  if (result.llmApiToken) result.llmApiToken = '[configured]';
  return result;
}

function providerLabel(value) {
  return value === 'lmstudio' ? 'LM Studio' : value === 'ollama' ? 'Ollama' : 'Local LLM';
}

function compactTaskLabel(settings) {
  if (settings.llmProvider === 'disabled') return 'LLM tasks off';
  const tasks = llmTasks(settings);
  const labels = [
    tasks.archiveReview ? compactReviewLabel(settings.llmArchiveReview) : null,
    tasks.summary ? 'Summary' : null,
    tasks.failedChecks ? 'Failed checks' : null,
    tasks.commitMessage ? 'Commit' : null,
  ].filter(Boolean);
  return labels.length ? labels.join('+') : 'No LLM tasks';
}

function compactReviewLabel(value) {
  if (value === 'structure') return 'Structure';
  if (value === 'sample') return 'Sample guard';
  if (value === 'patch') return 'Deep review';
  return 'Review';
}
