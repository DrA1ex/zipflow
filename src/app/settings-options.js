import path from 'node:path';
import { LLM_LANGUAGES, THEME_NAMES } from '../settings/store.js';
import { displayPath, expandHome } from '../utils/paths.js';
import { formatByteSize } from '../utils/size.js';
import { modelConfigSummary } from './settings-model.js';

export function settingsDefinitions(state) {
  const definitions = [
    { id: 'theme', label: 'Theme', description: 'Choose the color theme used by every project.', directParameterId: 'theme' },
    { id: 'checkOutput', label: 'Running checks', description: 'Choose how much command output is shown while checks run.', directParameterId: 'checkOutput' },
    { id: 'localLlm', label: 'Local LLM', description: 'Provider, model, response language, and authentication.' },
    { id: 'sourceArchive', label: 'Source archives', description: 'What happens to an uploaded ZIP after a completed update.' },
  ];
  if (state.project) definitions.push({
    id: 'managedHistory',
    label: 'Managed history',
    description: 'Choose whether to keep or reset paths recorded by Zipflow.',
    directParameterId: 'managedHistoryReset',
  });
  return definitions;
}

export function settingsParameters(state, definition) {
  if (definition.id === 'theme') return [choiceParameter('theme', 'Theme', titleCase(state.settings.theme), 'Choose one of the built-in Terlio themes.')];
  if (definition.id === 'checkOutput') return [choiceParameter(
    'checkOutput', 'Output while running', outputLabel(state.settings.checkOutput),
    'Compact shows status only; last-line also shows the latest command output line.',
  )];
  if (definition.id === 'localLlm') return localLlmParameters(state);
  if (definition.id === 'sourceArchive') return sourceArchiveParameters(state);
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
  if (parameter.settingId === 'llmLanguage') return LLM_LANGUAGES.map((value) => option(parameter, value, value));
  if (parameter.settingId === 'llmArchiveReview') return [
    option(parameter, 'disabled', 'Summary only', 'Generate summary and commit message without an archive suitability verdict.'),
    option(parameter, 'structure', 'Structure guard', 'Compare the project and archive trees before the patch summary request.'),
    option(parameter, 'patch', 'Deep patch review', 'Assess archive suitability together with summary and commit message from changes.patch.'),
  ];
  if (parameter.settingId === 'llmChangeDelivery') return [
    option(parameter, 'adaptive', 'Adaptive', 'Use a full patch when it fits; otherwise switch to file-by-file chunk analysis.'),
    option(parameter, 'patch', 'Full patch', 'Send one context-budgeted changes.patch request.'),
    option(parameter, 'change-list', 'Changed paths only', 'Send created, updated, and deleted file paths without file contents.'),
    option(parameter, 'chunked', 'File-by-file chunks', 'Analyze small groups of file patches, then synthesize one final answer.'),
  ];
  if (parameter.settingId === 'llmFailureAnalysis') return [
    option(parameter, 'disabled', 'Disabled', 'Do not send failed check output to the local model.'),
    option(parameter, 'same-context', 'Continue change context', 'Explain the failure using the previous change review summary as context.'),
    option(parameter, 'new-context', 'New context', 'Explain only the failed command and its output in a fresh request.'),
  ];
  if (parameter.settingId === 'archivePolicy') return [
    option(parameter, 'keep', 'Do nothing', 'Leave the ZIP in its original location.'),
    option(parameter, 'move', 'Move to archive storage', 'Move the ZIP and enforce retention and size limits.'),
    option(parameter, 'delete', 'Delete source ZIP', 'Delete the uploaded ZIP after the update is completed.'),
  ];
  if (parameter.id === 'managedHistoryReset') return [
    { id: 'history-cancel', action: 'history-cancel', label: 'Keep history', description: 'Return without changing managed-file history.' },
    { id: 'history-reset-confirm', action: 'history-reset-confirm', label: 'Reset history', description: 'Forget every path previously created or updated by Zipflow.' },
  ];
  return [];
}

export function settingsFieldDefinition(fieldId) {
  return FIELD_DEFINITIONS[fieldId] ?? null;
}

export function settingsEditorValue(state, fieldId) {
  if (fieldId === 'llmApiToken') return '';
  if (fieldId === 'archiveMaxBytes') return formatByteSize(state.settings[fieldId]).replace(/\s+/g, '');
  return String(state.settings[fieldId] ?? '');
}

function localLlmParameters(state) {
  const disabled = state.settings.llmProvider === 'disabled';
  const models = state.settingsPanel?.models ?? [];
  const selected = models.find((item) => item.id === state.settings.llmModel || item.key === state.settings.llmModel);
  return [
    choiceParameter('llmProvider', 'Provider', providerLabel(state.settings.llmProvider), 'Select the local LLM server implementation.'),
    {
      ...choiceParameter('llmModel', 'Model', selected ? modelDisplayLabel(selected) : (state.settings.llmModel || 'Not selected'), 'Choose a model exposed by the selected provider.'),
      disabled,
      disabledReason: 'Enable Ollama or LM Studio first.',
    },
    {
      ...choiceParameter('llmLanguage', 'Response language', state.settings.llmLanguage, 'The prompt remains English; summary and commit message use this language.'),
      disabled,
      disabledReason: 'Enable a local LLM provider first.',
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
  ];
}

function sourceArchiveParameters(state) {
  const parameters = [choiceParameter(
    'archivePolicy', 'Policy', archivePolicyLabel(state.settings.archivePolicy),
    'Choose what Zipflow does with the source ZIP after a completed update.',
  )];
  if (state.settings.archivePolicy === 'move') parameters.push(
    inputParameter('archiveDirectory', 'Archive directory', displayArchiveDirectory(state.settings.archiveDirectory), 'Where completed source ZIPs are moved.'),
    inputParameter('archiveRetentionDays', 'Retention', `${state.settings.archiveRetentionDays} days`, 'Maximum archive age; 0 disables age cleanup.'),
    inputParameter('archiveMaxBytes', 'Maximum size', formatByteSize(state.settings.archiveMaxBytes), 'Combined size limit; 0 disables size cleanup.'),
  );
  return parameters;
}

function managedHistoryParameters(state) {
  const active = state.run && state.plan && !state.run.applied;
  return [{
    id: 'managedHistoryReset',
    type: 'choice',
    label: 'Recorded paths',
    value: `${state.settingsPanel?.managedCount ?? 0}`,
    description: active
      ? 'History cannot be reset during an active update.'
      : 'Open to reset managed-file history for the current project.',
    disabled: Boolean(active),
  }];
}

function modelChoices(state, parameter) {
  const panel = state.settingsPanel;
  const result = [{
    id: 'refresh-models', action: 'refresh-models', label: panel?.loadingModels ? 'Refreshing models…' : 'Refresh available models',
    description: panel?.modelError ?? 'Read the models currently exposed by the selected provider.',
    disabled: Boolean(panel?.loadingModels),
  }];
  if (panel?.models?.length) {
    result.push(...panel.models.map((model) => ({
      id: `${parameter.settingId}:${model.id}`,
      action: state.settings.llmProvider === 'lmstudio' ? 'configure-model' : null,
      model,
      settingId: state.settings.llmProvider === 'lmstudio' ? null : parameter.settingId,
      value: model.id,
      label: modelDisplayLabel(model),
      description: model.loaded
        ? `Loaded · ${modelConfigSummary(state, model)}`
        : modelConfigSummary(state, model),
      selected: state.settings.llmModel === model.id || state.settings.llmModel === model.key,
    })));
  } else result.push({
    id: 'no-models', label: panel?.modelError ? 'Models unavailable' : 'No models returned',
    description: panel?.modelError ?? 'Refresh after starting the local LLM server.', disabled: true,
  });
  return result;
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
  if (value === 'patch') return 'Deep patch review';
  return 'Summary only';
}


function changeDeliveryLabel(value) {
  if (value === 'patch') return 'Full patch';
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
    instructions: ['The token is stored locally in ~/.zipflow/settings.json and is never shown in Activity.'],
    secret: true,
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
