const RUN_SETTING_KEYS = Object.freeze([
  'checkOutput',
  'llmProvider',
  'llmModel',
  'llmLanguage',
  'llmApiToken',
  'llmArchiveReview',
  'llmChangeDelivery',
  'llmFailureAnalysis',
  'llmModelLoadConfigs',
  'archivePolicy',
  'archiveDirectory',
  'archiveRetentionDays',
  'archiveMaxBytes',
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
  return `Current ${provider} · ${compactReviewLabel(settings.llmArchiveReview)} · edits → next run`;
}

function sanitizeRunSettings(settings) {
  const result = structuredClone(settings);
  if (result.llmApiToken) result.llmApiToken = '[configured]';
  return result;
}

function providerLabel(value) {
  return value === 'lmstudio' ? 'LM Studio' : value === 'ollama' ? 'Ollama' : 'Local LLM';
}

function compactReviewLabel(value) {
  if (value === 'structure') return 'Structure';
  if (value === 'patch') return 'Deep review';
  return 'Summary';
}

