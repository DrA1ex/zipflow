import { listLocalModels, providerDefinition } from '../llm/client.js';
import { loadManagedHistory, resetManagedHistory } from '../history/managed.js';
import { LLM_LANGUAGES, saveSettings, THEME_NAMES } from '../settings/store.js';
import { setScreen } from './state.js';

export function isSettingsScreen(screen) {
  return screen === 'settings';
}

export async function openSettings(controller) {
  const { state } = controller;
  if (state.busy || state.screen === 'checks-running' || state.screen === 'deploy-running') return false;
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
  if (definition.id === 'llmProvider') {
    state.settingsPanel.models = [];
    state.settingsPanel.modelsProvider = null;
    state.settingsPanel.modelError = null;
    if (option.value !== 'disabled') await refreshModels(controller, { quiet: true });
  }
  controller.setStatus(`${definition.label}: ${option.label}`);
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
    panel.models = await listLocalModels(provider);
    panel.modelsProvider = provider;
    if (!panel.models.includes(state.settings.llmModel)) {
      state.settings = await saveSettings({ ...state.settings, llmModel: '' });
    }
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
    && !panel.loadingModels) {
    await refreshModels(controller, { quiet: true });
  }
}

function definitionsFor(state) {
  return [
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
      id: 'llmProvider', label: 'Local LLM provider', description: 'Generate a patch summary and proposed commit message after each archive is inspected.',
      options: [
        { value: 'disabled', label: 'Disabled', description: 'Do not contact a local LLM server.' },
        { value: 'ollama', label: 'Ollama', description: 'OpenAI-compatible server at 127.0.0.1:11434.' },
        { value: 'lmstudio', label: 'LM Studio', description: 'OpenAI-compatible server at 127.0.0.1:1234.' },
      ],
    },
    {
      id: 'llmModel', label: 'Local LLM model', description: modelDescription(state),
    },
    {
      id: 'llmLanguage', label: 'LLM response language', description: 'The prompt remains English; summary and commit message use this language.',
      options: LLM_LANGUAGES.map((value) => ({ value, label: value })),
    },
    {
      id: 'managedHistory', label: 'Managed-file history', description: `${state.settingsPanel?.managedCount ?? 0} paths are recorded for the current project. Snapshot mode can use this list as its deletion boundary.`,
    },
  ];
}

function optionsFor(state, definition) {
  if (definition.options) return definition.options;
  if (definition.id === 'llmModel') {
    if (state.settings.llmProvider === 'disabled') return [{ value: '', label: 'Provider is disabled', disabled: true }];
    const panel = state.settingsPanel;
    const refresh = { action: 'refresh-models', label: panel?.loadingModels ? 'Loading models…' : 'Refresh available models', disabled: panel?.loadingModels };
    const models = (panel?.models ?? []).map((model) => ({ value: model, label: model }));
    if (!models.length) {
      return [refresh, { value: '', label: panel?.modelError ? `Unavailable: ${panel.modelError}` : 'No models returned', disabled: true }];
    }
    return [refresh, ...models];
  }
  if (definition.id === 'managedHistory') {
    if (state.run && state.plan && !state.run.applied) {
      return [{ label: 'Unavailable during an active update', description: 'Cancel or finish the current archive plan before resetting its deletion history.', disabled: true }];
    }
    if (state.settingsPanel?.confirmHistoryReset) return [
      { action: 'confirm-history-reset', label: 'Confirm reset', description: 'Forget every path previously created or updated by Zipflow for this project.' },
      { action: 'cancel-history-reset', label: 'Cancel' },
    ];
    return [{ action: 'reset-history', label: 'Reset managed-file history', description: 'This does not change project files. Future managed-history snapshots start from an empty list.' }];
  }
  return [];
}

function currentDefinition(state) {
  return definitionsFor(state)[state.settingsPanel?.settingIndex ?? 0];
}

function optionIndexFor(state, definition) {
  const options = optionsFor(state, definition);
  const index = options.findIndex((option) => option.value !== undefined && option.value === state.settings[definition.id]);
  return Math.max(0, index);
}

function modelDescription(state) {
  if (state.settings.llmProvider === 'disabled') return 'Choose a provider first.';
  return state.settings.llmModel ? `Selected: ${state.settings.llmModel}` : 'Refresh the provider model list, then choose one model.';
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
