import path from 'node:path';
import { listLocalModels, providerDefinition } from '../llm/client.js';
import { loadManagedHistory, resetManagedHistory } from '../history/managed.js';
import { LLM_LANGUAGES, saveSettings, THEME_NAMES } from '../settings/store.js';
import { ensureDir } from '../utils/fs.js';
import { displayPath, expandHome } from '../utils/paths.js';
import { formatByteSize, parseByteSize } from '../utils/size.js';
import { setScreen } from './state.js';

export function isSettingsScreen(screen) {
  return screen === 'settings';
}

export function isSettingsEditorScreen(screen) {
  return screen === 'settings-input';
}

export async function openSettings(controller) {
  const { state } = controller;
  if (state.busy || ['checks-running', 'deploy-running'].includes(state.screen)) return false;
  const history = state.project ? await loadManagedHistory(state.project.root) : { paths: [] };
  state.settingsPanel = {
    previous: {
      screen: state.screen,
      menuItems: state.menuItems,
      selectedIndex: state.selectedIndex,
      status: state.status,
    },
    focus: 'settings',
    settingIndex: 0,
    optionIndex: 0,
    models: [],
    modelsProvider: null,
    modelError: null,
    loadingModels: false,
    managedCount: history.paths.length,
    confirmHistoryReset: false,
    editorField: null,
  };
  setScreen(state, 'settings', { status: 'Global settings' });
  controller.invalidate();
  if (state.settings.llmProvider !== 'disabled') await refreshModels(controller, { quiet: true });
  return true;
}

export function closeSettings(controller) {
  const panel = controller.state.settingsPanel;
  if (!panel) return;
  const { previous } = panel;
  controller.state.settingsPanel = null;
  setScreen(controller.state, previous.screen, {
    items: previous.menuItems,
    selectedIndex: previous.selectedIndex,
    status: previous.status,
  });
  controller.invalidate();
}

export function backSettingsEditor(controller) {
  const panel = controller.state.settingsPanel;
  if (!panel) return controller.showHome();
  panel.editorField = null;
  setScreen(controller.state, 'settings', { status: 'Global settings' });
  controller.invalidate();
}

export async function submitSettingsEditor(controller) {
  const { state } = controller;
  const field = state.settingsPanel?.editorField;
  if (!field) return false;
  const entered = state.editor.value.trim();
  try {
    let value = entered;
    if (field.id === 'archiveDirectory') {
      if (!entered) throw new Error('Enter an archive directory.');
      const absolute = path.resolve(expandHome(entered));
      await ensureDir(absolute);
      value = entered;
    } else if (field.id === 'archiveRetentionDays') {
      value = parseInteger(entered, 'retention days', 0, 36_500);
    } else if (field.id === 'archiveMaxBytes') {
      value = parseByteSize(entered);
    } else if (field.id === 'llmApiToken') {
      value = entered;
    }
    state.settings = await saveSettings({ ...state.settings, [field.id]: value });
    state.settingsPanel.editorField = null;
    setScreen(state, 'settings', { status: `${field.label} saved` });
    if (field.id === 'llmApiToken') {
      state.settingsPanel.models = [];
      state.settingsPanel.modelsProvider = null;
      state.settingsPanel.modelError = null;
    }
    state.settingsPanel.optionIndex = optionIndexFor(state, currentDefinition(state));
    controller.invalidate();
    return true;
  } catch (error) {
    controller.setStatus(error.message);
    return true;
  }
}

export async function handleSettingsKey(controller, key) {
  const { state } = controller;
  const panel = state.settingsPanel;
  if (!panel) return false;
  if (key.name === 'escape' || (key.ctrl && key.name === 'b')) {
    closeSettings(controller);
    return true;
  }
  if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
    panel.focus = panel.focus === 'settings' ? 'options' : 'settings';
    panel.optionIndex = optionIndexFor(state, currentDefinition(state));
    controller.invalidate();
    return true;
  }
  if (key.name === 'up' || key.name === 'down') {
    const delta = key.name === 'up' ? -1 : 1;
    if (panel.focus === 'settings') {
      panel.settingIndex = wrap(panel.settingIndex + delta, definitionsFor(state).length);
      panel.optionIndex = optionIndexFor(state, currentDefinition(state));
      await ensureDefinitionData(controller, currentDefinition(state));
    } else {
      panel.optionIndex = wrap(panel.optionIndex + delta, optionsFor(state, currentDefinition(state)).length);
    }
    controller.invalidate();
    return true;
  }
  if (key.name === 'enter' || key.name === 'space') {
    if (panel.focus === 'settings') {
      panel.focus = 'options';
      await ensureDefinitionData(controller, currentDefinition(state));
      panel.optionIndex = optionIndexFor(state, currentDefinition(state));
      controller.invalidate();
      return true;
    }
    await activateOption(controller, panel.optionIndex);
    return true;
  }
  return true;
}

export async function selectSetting(controller, index) {
  const panel = controller.state.settingsPanel;
  if (!panel) return;
  panel.settingIndex = clamp(index, 0, definitionsFor(controller.state).length - 1);
  panel.focus = 'settings';
  await ensureDefinitionData(controller, currentDefinition(controller.state));
  panel.optionIndex = optionIndexFor(controller.state, currentDefinition(controller.state));
  controller.invalidate();
}

export async function selectOption(controller, index) {
  const panel = controller.state.settingsPanel;
  if (!panel) return;
  panel.optionIndex = clamp(index, 0, optionsFor(controller.state, currentDefinition(controller.state)).length - 1);
  panel.focus = 'options';
  await activateOption(controller, panel.optionIndex);
}

export function settingsViewModel(state) {
  const definitions = definitionsFor(state);
  const definition = currentDefinition(state);
  return {
    definitions,
    settingIndex: state.settingsPanel?.settingIndex ?? 0,
    optionIndex: state.settingsPanel?.optionIndex ?? 0,
    focus: state.settingsPanel?.focus ?? 'settings',
    options: optionsFor(state, definition),
    selectedSetting: definition,
  };
}

async function activateOption(controller, index) {
  const { state } = controller;
  const definition = currentDefinition(state);
  const option = optionsFor(state, definition)[index];
  if (!option || option.disabled) return;
  if (option.action === 'refresh-models') return refreshModels(controller);
  if (option.action === 'edit-setting') return openSettingEditor(controller, definition);
  if (option.action === 'clear-token') {
    state.settings = await saveSettings({ ...state.settings, llmApiToken: '' });
    state.settingsPanel.models = [];
    state.settingsPanel.modelsProvider = null;
    state.settingsPanel.modelError = null;
    return controller.setStatus('LLM API token cleared');
  }
  if (option.action === 'reset-history') {
    state.settingsPanel.confirmHistoryReset = true;
    state.settingsPanel.optionIndex = 0;
    controller.setStatus('Confirm managed-file history reset');
    return;
  }
  if (option.action === 'cancel-history-reset') {
    state.settingsPanel.confirmHistoryReset = false;
    controller.setStatus('Managed-file history was not changed');
    return;
  }
  if (option.action === 'confirm-history-reset') {
    const result = await resetManagedHistory(state.project.root);
    state.settingsPanel.managedCount = 0;
    state.settingsPanel.confirmHistoryReset = false;
    controller.message('Managed-file history reset', [`${result.removed} recorded paths removed.`], 'warning');
    controller.setStatus('Managed-file history reset');
    return;
  }
  state.settings = await saveSettings({ ...state.settings, [definition.id]: option.value });
  if (definition.id === 'archivePolicy' && option.value === 'move') {
    await ensureDir(path.resolve(expandHome(state.settings.archiveDirectory)));
  }
  normalizePanelIndex(state);
  if (definition.id === 'llmProvider') {
    state.settingsPanel.models = [];
    state.settingsPanel.modelsProvider = null;
    state.settingsPanel.modelError = null;
    if (option.value !== 'disabled') await refreshModels(controller, { quiet: true });
  }
  controller.setStatus(`${definition.label}: ${option.label}`);
}

function openSettingEditor(controller, definition) {
  const { state } = controller;
  state.settingsPanel.editorField = definition;
  const value = definition.id === 'llmApiToken' ? '' : editorValue(state, definition.id);
  controller.showEditor('settings-input', {
    label: definition.editorLabel ?? definition.label,
    purpose: `settings:${definition.id}`,
    placeholder: definition.placeholder ?? '',
    instructions: definition.editorInstructions ?? [],
  }, value);
}

async function refreshModels(controller, { quiet = false } = {}) {
  const { state } = controller;
  const provider = state.settings.llmProvider;
  if (provider === 'disabled') return;
  const panel = state.settingsPanel;
  panel.loadingModels = true;
  panel.modelError = null;
  controller.invalidate();
  try {
    panel.models = await listLocalModels(provider, { apiToken: state.settings.llmApiToken });
    panel.modelsProvider = provider;
    if (!panel.models.includes(state.settings.llmModel)) state.settings = await saveSettings({ ...state.settings, llmModel: '' });
    if (!quiet) controller.setStatus(`${panel.models.length} ${providerDefinition(provider).label} models available`);
  } catch (error) {
    panel.models = [];
    panel.modelsProvider = provider;
    panel.modelError = error.message;
    if (!quiet) controller.setStatus(error.message);
  } finally {
    panel.loadingModels = false;
    panel.optionIndex = optionIndexFor(state, currentDefinition(state));
    controller.invalidate();
  }
}

async function ensureDefinitionData(controller, definition) {
  const panel = controller.state.settingsPanel;
  if (definition.id === 'llmModel'
    && controller.state.settings.llmProvider !== 'disabled'
    && panel.modelsProvider !== controller.state.settings.llmProvider
    && !panel.loadingModels) await refreshModels(controller, { quiet: true });
}

function definitionsFor(state) {
  const definitions = [
    {
      id: 'theme', label: 'Theme', description: 'Color theme used by every project.',
      options: THEME_NAMES.map((value) => ({ value, label: titleCase(value) })),
    },
    {
      id: 'checkOutput', label: 'Running check output', description: 'How much command output is shown while checks are still running.',
      options: [
        { value: 'compact', label: 'Compact', description: 'Show only check states and durations.' },
        { value: 'last-line', label: 'Last output line', description: 'Also show the latest non-empty output line.' },
      ],
    },
    {
      id: 'llmProvider', label: 'Local LLM provider', description: 'Generate a streamed patch summary and proposed commit message after each archive is inspected.',
      options: [
        { value: 'disabled', label: 'Disabled', description: 'Do not contact a local LLM server.' },
        { value: 'ollama', label: 'Ollama', description: 'OpenAI-compatible server at 127.0.0.1:11434.' },
        { value: 'lmstudio', label: 'LM Studio', description: 'OpenAI-compatible server at 127.0.0.1:1234.' },
      ],
    },
  ];
  if (state.settings.llmProvider !== 'disabled') definitions.push(
    { id: 'llmApiToken', label: 'LLM API token', description: tokenDescription(state), input: true, editorLabel: 'LLM API token', placeholder: 'Optional bearer token', editorInstructions: ['Leave the field empty to remove authentication. The token is stored locally in ~/.zipflow/settings.json.'] },
    { id: 'llmModel', label: 'Local LLM model', description: modelDescription(state) },
    {
      id: 'llmLanguage', label: 'LLM response language', description: 'The prompt remains English; summary and commit message use this language.',
      options: LLM_LANGUAGES.map((value) => ({ value, label: value })),
    },
  );
  definitions.push({
    id: 'archivePolicy', label: 'Source ZIP after a run', description: 'Choose what Zipflow does with the uploaded source archive after an update is kept.',
    options: [
      { value: 'keep', label: 'Do nothing', description: 'Leave the ZIP in its original location.' },
      { value: 'move', label: 'Move to archive storage', description: 'Move the ZIP and enforce retention and size limits.' },
      { value: 'delete', label: 'Delete source ZIP', description: 'Delete the uploaded archive after the run is completed.' },
    ],
  });
  if (state.settings.archivePolicy === 'move') definitions.push(
    { id: 'archiveDirectory', label: 'Archive directory', description: `Current: ${displayArchiveDirectory(state.settings.archiveDirectory)}`, input: true, placeholder: '~/zipflow-archive', editorInstructions: ['The directory is created immediately if it does not exist.'] },
    { id: 'archiveRetentionDays', label: 'Archive retention', description: `${state.settings.archiveRetentionDays} days · use 0 to disable age-based cleanup`, input: true, placeholder: '30', editorInstructions: ['Only archives moved by Zipflow are eligible for cleanup.'] },
    { id: 'archiveMaxBytes', label: 'Archive size limit', description: `${formatByteSize(state.settings.archiveMaxBytes)} · use 0 for no size limit`, input: true, placeholder: '1GB', editorInstructions: ['Oldest Zipflow-managed archives are removed first when the limit is exceeded.'] },
  );
  if (state.project) definitions.push({
    id: 'managedHistory', label: 'Managed-file history', description: `${state.settingsPanel?.managedCount ?? 0} paths are recorded for the current project. Snapshot mode can use this list as its deletion boundary.`,
  });
  return definitions;
}

function optionsFor(state, definition) {
  if (definition.options) return definition.options;
  if (definition.input) {
    const options = [{ action: 'edit-setting', label: inputActionLabel(state, definition), description: inputActionDescription(definition) }];
    if (definition.id === 'llmApiToken' && state.settings.llmApiToken) options.push({ action: 'clear-token', label: 'Clear token' });
    return options;
  }
  if (definition.id === 'llmModel') {
    const panel = state.settingsPanel;
    const refresh = { action: 'refresh-models', label: panel?.loadingModels ? 'Loading models…' : 'Refresh available models', disabled: panel?.loadingModels };
    const models = (panel?.models ?? []).map((model) => ({ value: model, label: model }));
    if (!models.length) return [refresh, { value: '', label: panel?.modelError ? `Unavailable: ${panel.modelError}` : 'No models returned', disabled: true }];
    return [refresh, ...models];
  }
  if (definition.id === 'managedHistory') {
    if (state.run && state.plan && !state.run.applied) return [{ label: 'Unavailable during an active update', description: 'Cancel or finish the current archive plan before resetting its deletion history.', disabled: true }];
    if (state.settingsPanel?.confirmHistoryReset) return [
      { action: 'confirm-history-reset', label: 'Confirm reset', description: 'Forget every path previously created or updated by Zipflow for this project.' },
      { action: 'cancel-history-reset', label: 'Cancel' },
    ];
    return [{ action: 'reset-history', label: 'Reset managed-file history', description: 'This does not change project files. Future managed-history snapshots start from an empty list.' }];
  }
  return [];
}

function currentDefinition(state) {
  const definitions = definitionsFor(state);
  const index = clamp(state.settingsPanel?.settingIndex ?? 0, 0, Math.max(0, definitions.length - 1));
  if (state.settingsPanel) state.settingsPanel.settingIndex = index;
  return definitions[index];
}

function optionIndexFor(state, definition) {
  const options = optionsFor(state, definition);
  const index = options.findIndex((option) => option.value !== undefined && option.value === state.settings[definition.id]);
  return Math.max(0, index);
}

function normalizePanelIndex(state) {
  const definitions = definitionsFor(state);
  state.settingsPanel.settingIndex = clamp(state.settingsPanel.settingIndex, 0, Math.max(0, definitions.length - 1));
  state.settingsPanel.optionIndex = optionIndexFor(state, currentDefinition(state));
}

function editorValue(state, id) {
  if (id === 'archiveMaxBytes') return formatByteSize(state.settings[id]).replace(/\s+/g, '');
  return String(state.settings[id] ?? '');
}

function inputActionLabel(state, definition) {
  if (definition.id === 'llmApiToken') return state.settings.llmApiToken ? 'Replace configured token' : 'Set optional token';
  return `Edit ${definition.label.toLowerCase()}`;
}

function inputActionDescription(definition) {
  return definition.id === 'llmApiToken' ? 'The current token is never displayed.' : '';
}

function tokenDescription(state) {
  return state.settings.llmApiToken ? 'A bearer token is configured. Its value is hidden.' : 'No token. Local Ollama and LM Studio usually work without authentication.';
}

function modelDescription(state) {
  return state.settings.llmModel ? `Selected: ${state.settings.llmModel}` : 'Refresh the provider model list, then choose one model.';
}

function displayArchiveDirectory(value) {
  return displayPath(path.resolve(expandHome(value)));
}

function parseInteger(value, label, min, max) {
  if (!/^\d+$/.test(value)) throw new Error(`Enter ${label} as a whole number.`);
  return clamp(Number(value), min, max);
}

function wrap(value, length) {
  return length ? (value + length) % length : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
