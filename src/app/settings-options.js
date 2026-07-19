import path from 'node:path';
import { LLM_LANGUAGES, THEME_NAMES } from '../settings/store.js';
import { displayPath, expandHome } from '../utils/paths.js';
import { formatByteSize } from '../utils/size.js';

export function settingsDefinitions(state) {
  const definitions = [
    {
      id: 'theme',
      primarySetting: 'theme',
      label: 'Theme',
      description: 'Color theme used by every project.',
    },
    {
      id: 'checkOutput',
      primarySetting: 'checkOutput',
      label: 'Running check output',
      description: 'How much command output is shown while checks are still running.',
    },
    {
      id: 'localLlm',
      primarySetting: 'llmProvider',
      label: 'Local LLM',
      description: 'Provider, model, response language, and optional API authentication.',
    },
    {
      id: 'sourceArchive',
      primarySetting: 'archivePolicy',
      label: 'Source archives',
      description: 'What Zipflow does with an uploaded ZIP after an update is kept.',
    },
  ];
  if (state.project) definitions.push({
    id: 'managedHistory',
    label: 'Managed-file history',
    description: `${state.settingsPanel?.managedCount ?? 0} paths are recorded for the current project.`,
  });
  return definitions;
}

export function settingsOptions(state, definition) {
  if (definition.id === 'theme') return THEME_NAMES.map((value) => choice('theme', value, titleCase(value), state));
  if (definition.id === 'checkOutput') return [
    choice('checkOutput', 'compact', 'Compact', state, 'Show only check states and durations.'),
    choice('checkOutput', 'last-line', 'Last output line', state, 'Also show the latest non-empty output line.'),
  ];
  if (definition.id === 'localLlm') return localLlmOptions(state);
  if (definition.id === 'sourceArchive') return sourceArchiveOptions(state);
  if (definition.id === 'managedHistory') return managedHistoryOptions(state);
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

function localLlmOptions(state) {
  const options = [
    section('Provider'),
    choice('llmProvider', 'disabled', 'Disabled', state, 'Do not contact a local LLM server.'),
    choice('llmProvider', 'ollama', 'Ollama', state, 'OpenAI-compatible server at 127.0.0.1:11434.'),
    choice('llmProvider', 'lmstudio', 'LM Studio', state, 'OpenAI-compatible server at 127.0.0.1:1234.'),
  ];
  if (state.settings.llmProvider === 'disabled') return options;

  const panel = state.settingsPanel;
  options.push(
    section('Model'),
    {
      id: 'refresh-models',
      action: 'refresh-models',
      label: panel?.loadingModels ? 'Loading models…' : 'Refresh available models',
      disabled: panel?.loadingModels,
      description: panel?.modelError ?? 'Read the models currently exposed by the selected provider.',
    },
  );
  const models = panel?.models ?? [];
  if (models.length) {
    options.push(...models.map((model) => choice('llmModel', model, model, state)));
  } else {
    options.push({
      id: 'no-models',
      label: panel?.modelError ? 'Models unavailable' : 'No models returned',
      description: panel?.modelError ?? 'Refresh after starting the local LLM server.',
      disabled: true,
    });
  }
  options.push(
    section('Response language'),
    ...LLM_LANGUAGES.map((value) => choice('llmLanguage', value, value, state)),
    section('Authentication'),
    {
      id: 'edit-llm-token',
      action: 'edit-setting',
      fieldId: 'llmApiToken',
      label: state.settings.llmApiToken ? 'Replace API token' : 'Set optional API token',
      description: state.settings.llmApiToken
        ? 'A bearer token is configured. Its value is never displayed.'
        : 'Usually unnecessary for a local Ollama or LM Studio server.',
    },
  );
  if (state.settings.llmApiToken) options.push({
    id: 'clear-llm-token',
    action: 'clear-token',
    label: 'Clear API token',
  });
  return options;
}

function sourceArchiveOptions(state) {
  const options = [
    section('After a completed update'),
    choice('archivePolicy', 'keep', 'Do nothing', state, 'Leave the ZIP in its original location.'),
    choice('archivePolicy', 'move', 'Move to archive storage', state, 'Move the ZIP and enforce retention and size limits.'),
    choice('archivePolicy', 'delete', 'Delete source ZIP', state, 'Delete the uploaded ZIP after the run is completed.'),
  ];
  if (state.settings.archivePolicy !== 'move') return options;
  options.push(
    section('Archive storage'),
    editAction('archiveDirectory', `Directory · ${displayArchiveDirectory(state.settings.archiveDirectory)}`, 'The directory is created when saved if it does not exist.'),
    editAction('archiveRetentionDays', `Retention · ${state.settings.archiveRetentionDays} days`, 'Whole days. Use 0 to disable age-based cleanup.'),
    editAction('archiveMaxBytes', `Maximum size · ${formatByteSize(state.settings.archiveMaxBytes)}`, 'Accepts B, KB, MB, GB, KiB, MiB, or GiB. Use 0 for no size limit.'),
  );
  return options;
}

function managedHistoryOptions(state) {
  if (state.run && state.plan && !state.run.applied) return [{
    id: 'history-unavailable',
    label: 'Unavailable during an active update',
    description: 'Cancel or finish the current archive plan before resetting its deletion history.',
    disabled: true,
  }];
  if (state.settingsPanel?.confirmHistoryReset) return [
    { id: 'confirm-history-reset', action: 'confirm-history-reset', label: 'Confirm reset', description: 'Forget every path previously created or updated by Zipflow for this project.' },
    { id: 'cancel-history-reset', action: 'cancel-history-reset', label: 'Cancel' },
  ];
  return [{
    id: 'reset-history',
    action: 'reset-history',
    label: 'Reset managed-file history',
    description: 'This does not change project files. Future managed-history snapshots start from an empty list.',
  }];
}

function choice(settingId, value, label, state, description = '') {
  return {
    id: `${settingId}:${value}`,
    settingId,
    value,
    label,
    description,
    selected: state.settings[settingId] === value,
  };
}

function section(label) {
  return { id: `section:${label}`, label, section: true, disabled: true };
}

function editAction(fieldId, label, description) {
  return { id: `edit:${fieldId}`, action: 'edit-setting', fieldId, label, description };
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
