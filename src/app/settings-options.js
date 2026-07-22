import path from 'node:path';
import { LLM_LANGUAGES, THEME_NAMES } from '../settings/store.js';
import { displayPath, expandHome } from '../utils/paths.js';
import { formatByteSize } from '../utils/size.js';
import { modelConfigSummary } from './settings-model.js';
import { modelTestDescription, modelTestValue } from './settings-model-check.js';

export function settingsDefinitions(state) {
  const definitions = [
    { id: 'theme', label: 'Theme', description: '', directParameterId: 'theme' },
    { id: 'checkOutput', label: 'Running checks', description: '', directParameterId: 'checkOutput' },
    { id: 'localLlm', label: 'Local LLM', description: 'Provider, model, languages, review behavior, and authentication.' },
    { id: 'sourceArchive', label: 'Source archives', description: 'Retention and storage for completed source ZIPs.' },
    { id: 'backups', label: 'Backups', description: 'Retention and storage for rollback backups.' },
  ];
  if (state.project) definitions.push({
    id: 'managedHistory',
    label: 'Managed-file history',
    description: 'Control whether successful updates record managed paths and inspect the current project history.',
  });
  return definitions;
}

export function settingsParameters(state, definition) {
  if (definition.id === 'theme') return [choiceParameter('theme', 'Theme', titleCase(state.settings.theme), '')];
  if (definition.id === 'checkOutput') return [choiceParameter(
    'checkOutput', 'Output while running', outputLabel(state.settings.checkOutput),
    'Compact shows status only; last-line also shows the latest command output line.',
  )];
  if (definition.id === 'localLlm') {
    if (state.settingsPanel?.subpage === 'llmLanguages') return llmLanguageParameters(state);
    if (state.settingsPanel?.subpage === 'llmModelTests') return llmModelTestParameters(state);
    if (state.settingsPanel?.subpage === 'llmModelReplay') return llmModelReplayParameters(state);
    return localLlmParameters(state);
  }
  if (definition.id === 'sourceArchive') return sourceArchiveParameters(state);
  if (definition.id === 'backups') return backupParameters(state);
  if (definition.id === 'managedHistory') return managedHistoryParameters(state);
  return [];
}

export function settingsChoices(state, parameter) {
  if (parameter.settingId === 'theme') return THEME_NAMES.map((value) => option(parameter, value, titleCase(value)));
  if (parameter.settingId === 'checkOutput') return [
    option(parameter, 'compact', 'Compact', 'Show check state and duration only.'),
    option(parameter, 'last-line', 'Last output line', 'Also show the latest non-empty output line.'),
  ];
  if (parameter.settingId === 'llmProvider') return [
    option(parameter, 'disabled', 'Disabled', 'Do not contact a local LLM server.'),
    option(parameter, 'ollama', 'Ollama', 'Local server at 127.0.0.1:11434.'),
    option(parameter, 'lmstudio', 'LM Studio', 'Native API at 127.0.0.1:1234/api/v1.'),
  ];
  if (parameter.settingId === 'llmModel') return modelChoices(state, parameter);
  if (['llmPromptLanguage', 'llmSummaryLanguage', 'llmCommitLanguage'].includes(parameter.settingId)) {
    return LLM_LANGUAGES.map((value) => option(parameter, value, value));
  }
  if (parameter.settingId === 'llmArchiveReview') return [
    option(parameter, 'disabled', 'Summary only', 'Generate summary and commit message without an archive suitability verdict.'),
    option(parameter, 'structure', 'Structure guard', 'Compare the project and archive trees before the patch summary request.'),
    option(parameter, 'sample', 'Sample guard', 'Check both project/archive structure and representative patch excerpts from up to five priority files.'),
    option(parameter, 'patch', 'Deep patch review', 'Assess archive suitability together with summary and commit message from changes.patch.'),
  ];
  if (parameter.settingId === 'llmChangeDelivery') return [
    option(parameter, 'adaptive', 'Adaptive', 'Use a full patch when it fits, a representative sample for medium changes, and capped batches for large changes.'),
    option(parameter, 'patch', 'Full patch', 'Send one context-budgeted changes.patch request.'),
    option(parameter, 'representative', 'Representative sample', 'Send the full changed-path manifest and representative patches from up to eight priority files.'),
    option(parameter, 'capped', 'Capped batches', 'Analyze at most three priority batches and twelve files, then synthesize one result.'),
    option(parameter, 'change-list', 'Changed paths only', 'Send created, updated, and deleted file paths without file contents.'),
    option(parameter, 'chunked', 'File-by-file chunks', 'Analyze small groups of file patches, then synthesize one final answer.'),
  ];
  if (parameter.settingId === 'llmFailureAnalysis') return [
    option(parameter, 'disabled', 'Disabled', 'Do not send failed check output to the local model.'),
    option(parameter, 'same-context', 'Continue change context', 'Explain the failure using the previous change review summary as context.'),
    option(parameter, 'new-context', 'New context', 'Explain only the failed command and its output in a fresh request.'),
  ];
  if (parameter.settingId === 'backupRetentionPolicy') return [
    option(parameter, 'all', 'Keep all backups', 'Never remove backups automatically. Manual Clear now remains available.'),
    option(parameter, 'limits', 'Keep backups within limits', 'Remove oldest backups after successful runs when age or total-size limits are exceeded.'),
  ];
  if (parameter.settingId === 'managedHistoryPolicy') return [
    option(parameter, 'record', 'Keep recording managed files', 'Successful archive updates add created and updated paths to managed-file history.'),
    {
      ...option(parameter, 'disabled', 'Do not record managed files', 'Keep existing history but stop updating it after future runs.'),
      disabled: state.workflow?.deletion?.scope === 'managed-history',
      disabledReason: 'The active workflow uses managed-file history for snapshot deletion. Change that workflow policy first.',
    },
  ];
  if (parameter.settingId === 'archivePolicy') return [
    option(parameter, 'keep', 'Do nothing', 'Leave the ZIP in its original location.'),
    option(parameter, 'move', 'Move to archive storage', 'Move the ZIP and enforce retention and size limits.'),
    option(parameter, 'delete', 'Delete source ZIP', 'Delete the uploaded ZIP after the update is completed.'),
  ];
  if (parameter.id === 'archiveStorageClear') return clearChoices('archive-storage',
    `Delete ${state.settingsPanel?.storageStats?.archives?.count ?? 0} Zipflow-managed source archives.`);
  if (parameter.id === 'backupStorageClear') return clearChoices('backup-storage',
    `Delete ${state.settingsPanel?.storageStats?.backups?.count ?? 0} backups. Rollback will become unavailable for affected runs.`);
  if (parameter.id === 'managedHistoryClear') return clearChoices('managed-history',
    `Forget ${state.settingsPanel?.managedHistory?.paths?.length ?? 0} recorded paths for this project.`);
  return [];
}

export function settingsPageTitle(state, definition) {
  if (definition.id === 'localLlm' && state.settingsPanel?.subpage === 'llmLanguages') return 'LLM languages';
  if (definition.id === 'localLlm' && state.settingsPanel?.subpage === 'llmModelTests') return 'Model tests';
  if (definition.id === 'localLlm' && state.settingsPanel?.subpage === 'llmModelReplay') {
    return state.settingsPanel?.modelTestWorkspace ? 'Model tests' : 'Historical model replay';
  }
  return definition.label;
}

export function settingsFieldDefinition(fieldId) {
  return FIELD_DEFINITIONS[fieldId] ?? null;
}

export function settingsEditorValue(state, fieldId) {
  if (fieldId === 'llmApiToken') return '';
  if (['archiveMaxBytes', 'backupMaxBytes'].includes(fieldId)) return formatByteSize(state.settings[fieldId]).replace(/\s+/g, '');
  return String(state.settings[fieldId] ?? '');
}

function localLlmParameters(state) {
  const disabled = state.settings.llmProvider === 'disabled';
  const models = state.settingsPanel?.models ?? [];
  const selected = models.find((item) => item.id === state.settings.llmModel || item.key === state.settings.llmModel);
  return [
    choiceParameter('llmProvider', 'Provider', providerLabel(state.settings.llmProvider), 'Choose the local server Zipflow should contact.'),
    {
      ...choiceParameter('llmModel', 'Model', selected ? modelDisplayLabel(selected) : (state.settings.llmModel || 'Not selected'), ''),
      disabled,
      disabledReason: 'Enable Ollama or LM Studio first.',
    },
    {
      id: 'llmLanguages', type: 'subpage', label: 'Languages',
      value: languageSummary(state.settings),
      description: 'Configure the language of model instructions, summaries, and generated commit messages independently.',
      disabled, disabledReason: 'Enable a local LLM provider first.',
    },
    {
      ...choiceParameter('llmArchiveReview', 'Archive review', archiveReviewLabel(state.settings.llmArchiveReview), 'Optional LLM safety assessment; deterministic Zipflow checks always remain authoritative.'),
      disabled,
      disabledReason: 'Enable a local LLM provider first.',
    },
    {
      ...choiceParameter('llmChangeDelivery', 'Change delivery', changeDeliveryLabel(state.settings.llmChangeDelivery), 'Choose how source changes are represented and budgeted for the model.'),
      disabled,
      disabledReason: 'Enable a local LLM provider first.',
    },
    {
      ...choiceParameter('llmFailureAnalysis', 'Failed checks', failureAnalysisLabel(state.settings.llmFailureAnalysis), 'Optionally ask the model to explain failed checks after they run.'),
      disabled,
      disabledReason: 'Enable a local LLM provider first.',
    },
    {
      id: 'llmApiToken', type: 'input', fieldId: 'llmApiToken', label: 'Authentication',
      value: state.settings.llmApiToken ? 'Bearer token configured' : 'Not configured',
      description: 'Optional API token for model discovery and generation.',
    },
    {
      id: 'llmModelTests', type: 'subpage', label: 'Test selected model',
      value: modelTestValue(state.settingsPanel),
      description: modelTestDescription(state.settingsPanel),
      disabled: disabled || !state.settings.llmModel,
      blocked: Boolean(state.settingsPanel?.modelTest?.running),
      loading: Boolean(state.settingsPanel?.modelTest?.running),
      disabledReason: disabled
        ? 'Enable a local LLM provider first.'
        : !state.settings.llmModel ? 'Choose a model first.' : 'The selected model test is already running.',
    },
  ];
}

function llmLanguageParameters(state) {
  return [
    choiceParameter('llmPromptLanguage', 'Prompt language', state.settings.llmPromptLanguage,
      'Language used for model-facing instructions. Structured protocol names remain stable.'),
    choiceParameter('llmSummaryLanguage', 'Summary language', state.settings.llmSummaryLanguage,
      'Language used for change summaries, suitability reasons, and failed-check explanations.'),
    choiceParameter('llmCommitLanguage', 'Commit message language', state.settings.llmCommitLanguage,
      'Language used only for the generated Git commit message.'),
    { id: 'llmLanguagesBack', type: 'action', action: 'subpage-back', label: 'Back to Local LLM', value: '',
      description: 'Return to the Local LLM settings page.' },
  ];
}

function languageSummary(settings) {
  return `Prompt ${settings.llmPromptLanguage} · Summary ${settings.llmSummaryLanguage} · Commit ${settings.llmCommitLanguage}`;
}

function llmModelTestParameters(state) {
  const running = Boolean(state.settingsPanel?.modelTest?.running || state.settingsPanel?.modelTestWorkspace?.running);
  return [
    { id: 'modelTestConnection', type: 'action', action: 'model-test-connection',
      label: running && state.settingsPanel?.modelTest?.running ? 'Testing connection…' : 'Connection and compatibility test',
      value: modelTestValue(state.settingsPanel),
      description: modelTestDescription(state.settingsPanel), blocked: running, loading: running && Boolean(state.settingsPanel?.modelTest?.running) },
    { id: 'modelTestReplay', type: 'action', action: 'model-test-replay',
      label: 'Replay a historical update', value: '',
      description: 'Run the current LLM rules against a stored historical patch without changing project files.', blocked: running },
    { id: 'llmModelTestsBack', type: 'action', action: 'subpage-back', label: 'Back to Local LLM', value: '',
      description: 'Return to the Local LLM settings page.', blocked: running },
  ];
}

function llmModelReplayParameters(state) {
  const runs = state.settingsPanel?.replayRuns ?? [];
  const items = runs.map((run) => ({
    id: `modelReplay:${run.id}`, type: 'action', action: 'model-replay-run', runId: run.id,
    label: `${archiveName(run.archivePath)} · ${shortDate(run.createdAt)}`,
    value: run.plan?.counts ? `${run.plan.counts.created} added · ${run.plan.counts.updated} changed · ${run.plan.counts.deleted} removed` : '',
    description: run.replayAvailable
      ? `Replay stored changes.patch from run ${run.id}. Project files remain untouched.`
      : 'The stored patch is unavailable, so this run cannot be replayed.',
    disabled: !run.replayAvailable,
  }));
  if (!items.length) items.push({
    id: 'modelReplayEmpty', type: 'action', label: 'No replayable archive updates', value: '',
    description: 'Complete an archive update with a stored patch before using historical replay.', disabled: true,
  });
  items.push({ id: 'modelReplayBack', type: 'action', action: 'model-replay-back', label: 'Back to model tests', value: '',
    description: 'Return to test options.' });
  return items;
}

function archiveName(value) {
  return path.basename(String(value || 'archive update'));
}

function shortDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function sourceArchiveParameters(state) {
  const archives = state.settingsPanel?.storageStats?.archives ?? {};
  const loading = Boolean(state.settingsPanel?.loadingStorage);
  const parameters = [
    choiceParameter('archivePolicy', 'Policy', archivePolicyLabel(state.settings.archivePolicy),
      'Choose what Zipflow does with the source ZIP after a completed update.'),
  ];
  if (state.settings.archivePolicy === 'move') parameters.push(
    inputParameter('archiveDirectory', 'Archive directory', displayArchiveDirectory(state.settings.archiveDirectory),
      'Directory where completed source ZIPs are moved.'),
    inputParameter('archiveRetentionDays', 'Retention', `${state.settings.archiveRetentionDays} days`,
      'Maximum archive age; 0 disables age cleanup.'),
    inputParameter('archiveMaxBytes', 'Maximum size', formatByteSize(state.settings.archiveMaxBytes),
      'Combined managed archive size limit; 0 disables size cleanup.'),
  );
  parameters.push(
    actionRow('archiveStorageRefresh', 'Refresh statistics', loading ? 'Scanning…' : '',
      'Re-scan Zipflow-managed source archives.', { action: 'storage-refresh', disabled: loading, loading }),
    { ...choiceParameter('archiveStorageClear', 'Clear now', archives.count ? `${archives.count} files` : 'Empty',
      'Delete only source archives registered in Zipflow’s archive index.'), disabled: loading || !archives.count },
  );
  return parameters;
}

function backupParameters(state) {
  const backups = state.settingsPanel?.storageStats?.backups ?? {};
  const loading = Boolean(state.settingsPanel?.loadingStorage);
  const parameters = [
    choiceParameter('backupRetentionPolicy', 'Retention policy', backupPolicyLabel(state.settings.backupRetentionPolicy),
      'Keep every backup or automatically remove the oldest backups within configured limits.'),
  ];
  if (state.settings.backupRetentionPolicy === 'limits') parameters.push(
    inputParameter('backupRetentionDays', 'Retention', `${state.settings.backupRetentionDays} days`,
      'Maximum backup age; 0 disables age cleanup.'),
    inputParameter('backupMaxBytes', 'Maximum size', formatByteSize(state.settings.backupMaxBytes),
      'Maximum combined backup size; 0 disables size cleanup.'),
  );
  parameters.push(
    actionRow('backupStorageRefresh', 'Refresh statistics', loading ? 'Scanning…' : '',
      'Re-scan rollback backup storage.', { action: 'storage-refresh', disabled: loading, loading }),
    { ...choiceParameter('backupStorageClear', 'Clear now', backups.count ? `${backups.count} backups` : 'Empty',
      'Delete stored rollback backups except the backup belonging to an active run.'), disabled: loading || !backups.count },
  );
  return parameters;
}

function managedHistoryParameters(state) {
  const history = state.settingsPanel?.managedHistory ?? { paths: [], updatedAt: null };
  return [
    choiceParameter('managedHistoryPolicy', 'Recording', managedHistoryPolicyLabel(state.settings.managedHistoryPolicy),
      'Choose whether future successful archive updates update managed-file history.'),
    { ...choiceParameter('managedHistoryClear', 'Clear now', history.paths?.length ? `${history.paths.length} paths` : 'Empty',
      'Forget recorded paths without changing whether future runs are recorded.'),
      disabled: !history.paths?.length,
      disabledReason: '' },
  ];
}

export function settingsPageSummary(state, definition) {
  const loading = Boolean(state.settingsPanel?.loadingStorage);
  if (definition.id === 'sourceArchive') {
    const archives = state.settingsPanel?.storageStats?.archives ?? {};
    return [
      loading ? 'Scanning source archive storage…' : `${archives.count ?? 0} archives · ${formatByteSize(archives.totalBytes ?? 0)}`,
      `Oldest: ${loading ? 'Scanning…' : dateLabel(archives.oldestAt)}`,
      `Directory: ${displayArchiveDirectory(state.settings.archiveDirectory)}`,
    ];
  }
  if (definition.id === 'backups') {
    const backups = state.settingsPanel?.storageStats?.backups ?? {};
    return [
      loading ? 'Scanning backup storage…' : `${backups.count ?? 0} backups · ${backups.fileCount ?? 0} files · ${formatByteSize(backups.totalBytes ?? 0)}`,
      `Oldest: ${loading ? 'Scanning…' : dateLabel(backups.oldestAt)}`,
      `Directory: ${backups.directory ? displayPath(backups.directory) : '~/.zipflow/backups'}`,
    ];
  }
  if (definition.id === 'managedHistory') {
    const history = state.settingsPanel?.managedHistory ?? { paths: [], updatedAt: null };
    return [
      `${history.paths?.length ?? 0} recorded paths`,
      `Last updated: ${dateLabel(history.updatedAt)}`,
    ];
  }
  return [];
}

function actionRow(id, label, value, description, extra = {}) {
  return { id, type: 'action', label, value, description, ...extra };
}

function clearChoices(kind, description) {
  return [
    { id: `${kind}-clear-cancel`, action: 'clear-cancel', label: 'Back', description: 'Return without deleting anything.' },
    { id: `${kind}-clear-confirm`, action: `${kind}-clear-confirm`, label: 'Clear now', description },
  ];
}

function backupPolicyLabel(value) {
  return value === 'all' ? 'Keep all backups' : 'Keep backups within limits';
}

function managedHistoryPolicyLabel(value) {
  return value === 'disabled' ? 'Do not record managed files' : 'Keep recording managed files';
}

function dateLabel(value) {
  if (!value) return 'None';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function modelChoices(state, parameter) {
  const panel = state.settingsPanel;
  const result = [{
    id: 'refresh-models', action: 'refresh-models', label: 'Refresh available models',
    description: panel?.modelError ?? '',
    loading: Boolean(panel?.loadingModels),
    disabled: false,
  }];
  if (panel?.models?.length) {
    result.push(...panel.models.map((model) => ({
      id: `${parameter.settingId}:${model.id}`,
      action: state.settings.llmProvider === 'lmstudio' ? 'configure-model' : null,
      model,
      settingId: state.settings.llmProvider === 'lmstudio' ? null : parameter.settingId,
      value: model.id,
      label: modelChoiceLabel(model),
      description: modelChoiceDescription(state, model),
      selected: configuredModelMatches(state.settings.llmModel, model),
    })));
  } else result.push({
    id: 'no-models', label: panel?.modelError ? 'Models unavailable' : 'No models returned',
    description: panel?.modelError ?? 'Refresh after starting the local LLM server.', disabled: true,
  });
  return result;
}



function configuredModelMatches(configuredModel, model) {
  if (configuredModel === model.id || configuredModel === model.key) return true;
  if (model.loadedInstanceIds?.includes(configuredModel)) return true;
  return Boolean(model.key) && String(configuredModel ?? '').startsWith(`${model.key}:`);
}

function modelChoiceLabel(model) {
  return [model.label, model.paramsString, model.quantization].filter(Boolean).join(' · ');
}

function modelChoiceDescription(state, model) {
  const config = formatLoadedModelConfig(modelConfigSummary(state, model));
  if (model.loaded) return config ? `Loaded configuration: ${config}` : 'This model currently has a loaded LM Studio instance.';
  return config ? `Saved configuration: ${config}` : 'Open to configure and select this model.';
}

function formatLoadedModelConfig(value) {
  return String(value ?? '')
    .replace(/^context /i, 'Context ')
    .replace(/ · batch /i, ' · batch ')
    .replace(/ · flash /i, ' · flash ')
    .replace(/ · KV /i, ' · KV ');
}

function modelDisplayLabel(model) {
  const details = [model.paramsString, model.quantization].filter(Boolean);
  return details.length ? `${model.label} · ${details.join(' · ')}` : model.label;
}

function choiceParameter(settingId, label, value, description) {
  return { id: settingId, type: 'choice', settingId, label, value, description };
}

function inputParameter(fieldId, label, value, description) {
  return { id: fieldId, type: 'input', fieldId, label, value, description };
}

function option(parameter, value, label, description = '') {
  return { id: `${parameter.settingId}:${value}`, settingId: parameter.settingId, value, label, description };
}

function providerLabel(value) {
  return value === 'ollama' ? 'Ollama' : value === 'lmstudio' ? 'LM Studio' : 'Disabled';
}

function outputLabel(value) {
  return value === 'compact' ? 'Compact' : 'Last output line';
}

function archiveReviewLabel(value) {
  if (value === 'structure') return 'Structure guard';
  if (value === 'sample') return 'Sample guard';
  if (value === 'patch') return 'Deep patch review';
  return 'Summary only';
}


function changeDeliveryLabel(value) {
  if (value === 'patch') return 'Full patch';
  if (value === 'representative') return 'Representative sample';
  if (value === 'capped') return 'Capped batches';
  if (value === 'change-list') return 'Changed paths only';
  if (value === 'chunked') return 'File-by-file chunks';
  return 'Adaptive';
}

function failureAnalysisLabel(value) {
  if (value === 'same-context') return 'Continue change context';
  if (value === 'new-context') return 'New context';
  return 'Disabled';
}

function archivePolicyLabel(value) {
  return value === 'move' ? 'Move to archive storage' : value === 'delete' ? 'Delete source ZIP' : 'Do nothing';
}

function displayArchiveDirectory(value) {
  return displayPath(path.resolve(expandHome(value)));
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const FIELD_DEFINITIONS = Object.freeze({
  llmApiToken: {
    id: 'llmApiToken',
    label: 'LLM API token',
    description: 'Optional bearer token used for model discovery and generation.',
    placeholder: 'Paste token or leave empty to clear',
    instructions: ['The token is stored in macOS Keychain or the Linux system keyring, never in Zipflow JSON files.', 'On Linux, persistent storage requires secret-tool and an active Secret Service provider.'],
    secret: true,
  },
  backupRetentionDays: {
    id: 'backupRetentionDays', label: 'Backup retention',
    description: 'How long Zipflow backups may remain available for rollback.', placeholder: '30',
    unitHint: 'Unit: whole days. Enter 0 to disable age-based cleanup.',
  },
  backupMaxBytes: {
    id: 'backupMaxBytes', label: 'Backup maximum size',
    description: 'Maximum combined size of Zipflow rollback backups.', placeholder: '2GB',
    unitHint: 'Units: B, KB, MB, GB, KiB, MiB, GiB. Enter 0 for no size limit.',
  },
  archiveDirectory: {
    id: 'archiveDirectory',
    label: 'Archive directory',
    description: 'Directory where completed source ZIPs are moved.',
    placeholder: '~/zipflow-archive',
    instructions: ['The directory is created after validation if it does not exist.', 'Tab completes directory names.'],
    path: true,
  },
  archiveRetentionDays: {
    id: 'archiveRetentionDays',
    label: 'Archive retention',
    description: 'How long Zipflow-managed archives may remain in storage.',
    placeholder: '30',
    unitHint: 'Unit: whole days. Enter 0 to disable age-based cleanup.',
  },
  archiveMaxBytes: {
    id: 'archiveMaxBytes',
    label: 'Archive maximum size',
    description: 'Maximum combined size of archives managed by Zipflow.',
    placeholder: '1GB',
    unitHint: 'Units: B, KB, MB, GB, KiB, MiB, GiB. Enter 0 for no size limit.',
  },
});
