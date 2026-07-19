import path from 'node:path';
import { handleInputEditorKey } from 'terlio.js';
import { listLocalModels, providerDefinition } from '../llm/client.js';
import { loadManagedHistory, resetManagedHistory } from '../history/managed.js';
import { saveSettings } from '../settings/store.js';
import { ensureDir } from '../utils/fs.js';
import { completePath, expandHome } from '../utils/paths.js';
import { parseByteSize } from '../utils/size.js';
import { setScreen } from './state.js';
import {
  settingsDefinitions, settingsEditorValue, settingsFieldDefinition, settingsOptions,
} from './settings-options.js';

export function isSettingsScreen(screen) {
  return screen === 'settings';
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
    modal: null,
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
  if (!panel?.modal) return;
  panel.modal = null;
  controller.state.status = 'Global settings';
  controller.invalidate();
}

export async function submitSettingsEditor(controller) {
  const { state } = controller;
  const modal = state.settingsPanel?.modal;
  if (!modal) return false;
  const entered = state.editor.value.trim();
  try {
    const value = await validateSettingValue(modal.field, entered);
    state.settings = await saveSettings({ ...state.settings, [modal.field.id]: value });
    if (modal.field.id === 'llmApiToken') resetModelCache(state.settingsPanel);
    state.settingsPanel.modal = null;
    state.settingsPanel.optionIndex = findOptionIndex(state, modal.returnOptionId);
    state.status = `${modal.field.label} saved`;
    controller.invalidate();
    return true;
  } catch (error) {
    modal.error = error.message;
    state.status = error.message;
    controller.invalidate();
    return true;
  }
}

export async function handleSettingsKey(controller, key) {
  const panel = controller.state.settingsPanel;
  if (!panel) return false;
  if (panel.modal) return handleModalKey(controller, key);
  if (key.name === 'escape') {
    closeSettings(controller);
    return true;
  }
  if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
    panel.focus = panel.focus === 'settings' ? 'options' : 'settings';
    panel.optionIndex = preferredOptionIndex(controller.state);
    controller.invalidate();
    return true;
  }
  if (key.name === 'up' || key.name === 'down') {
    const delta = key.name === 'up' ? -1 : 1;
    if (panel.focus === 'settings') {
      panel.settingIndex = wrap(panel.settingIndex + delta, settingsDefinitions(controller.state).length);
      panel.optionIndex = preferredOptionIndex(controller.state);
      await ensureDefinitionData(controller, currentDefinition(controller.state));
    } else {
      panel.optionIndex = moveOption(controller.state, panel.optionIndex, delta);
    }
    controller.invalidate();
    return true;
  }
  if (key.name === 'enter' || key.name === 'space') {
    if (panel.focus === 'settings') {
      panel.focus = 'options';
      await ensureDefinitionData(controller, currentDefinition(controller.state));
      panel.optionIndex = preferredOptionIndex(controller.state);
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
  panel.settingIndex = clamp(index, 0, settingsDefinitions(controller.state).length - 1);
  panel.focus = 'settings';
  await ensureDefinitionData(controller, currentDefinition(controller.state));
  panel.optionIndex = preferredOptionIndex(controller.state);
  controller.invalidate();
}

export async function selectOption(controller, index) {
  const panel = controller.state.settingsPanel;
  if (!panel) return;
  panel.optionIndex = clamp(index, 0, optionsFor(controller.state).length - 1);
  panel.focus = 'options';
  await activateOption(controller, panel.optionIndex);
}

export function settingsViewModel(state) {
  const definitions = settingsDefinitions(state);
  const selectedSetting = currentDefinition(state);
  return {
    definitions,
    selectedSetting,
    options: settingsOptions(state, selectedSetting),
    settingIndex: state.settingsPanel?.settingIndex ?? 0,
    optionIndex: state.settingsPanel?.optionIndex ?? 0,
    focus: state.settingsPanel?.focus ?? 'settings',
    modal: state.settingsPanel?.modal ?? null,
  };
}

async function handleModalKey(controller, key) {
  const { state } = controller;
  const modal = state.settingsPanel.modal;
  if (key.name === 'escape') {
    backSettingsEditor(controller);
    return true;
  }
  if (key.name === 'tab' && modal.field.path) {
    const completion = await completePath(state.editor.value, {
      cwd: state.project?.root ?? process.cwd(),
      directoriesOnly: true,
    });
    if (completion.matches.length) {
      state.editor.set(completion.value);
      state.status = completion.matches.length === 1 ? 'Path completed' : `${completion.matches.length} matches`;
    } else state.status = 'No path matches';
    controller.invalidate();
    return true;
  }
  if (key.name === 'enter') return submitSettingsEditor(controller);
  modal.error = null;
  handleInputEditorKey(state.editor, key, { multiline: false });
  controller.invalidate();
  return true;
}

async function activateOption(controller, index) {
  const { state } = controller;
  const option = optionsFor(state)[index];
  if (!option || option.disabled) return;
  if (option.action === 'refresh-models') return refreshModels(controller);
  if (option.action === 'edit-setting') return openSettingModal(controller, option.fieldId, option.id);
  if (option.action === 'clear-token') {
    state.settings = await saveSettings({ ...state.settings, llmApiToken: '' });
    resetModelCache(state.settingsPanel);
    state.status = 'LLM API token cleared';
    controller.invalidate();
    return;
  }
  if (option.action === 'reset-history') {
    state.settingsPanel.confirmHistoryReset = true;
    state.settingsPanel.optionIndex = 0;
    state.status = 'Confirm managed-file history reset';
    controller.invalidate();
    return;
  }
  if (option.action === 'cancel-history-reset') {
    state.settingsPanel.confirmHistoryReset = false;
    state.status = 'Managed-file history was not changed';
    controller.invalidate();
    return;
  }
  if (option.action === 'confirm-history-reset') {
    const result = await resetManagedHistory(state.project.root);
    state.settingsPanel.managedCount = 0;
    state.settingsPanel.confirmHistoryReset = false;
    controller.message('Managed-file history reset', [`${result.removed} recorded paths removed.`], 'warning');
    state.status = 'Managed-file history reset';
    controller.invalidate();
    return;
  }
  if (option.settingId) await applyChoice(controller, option);
}

async function applyChoice(controller, option) {
  const { state } = controller;
  state.settings = await saveSettings({ ...state.settings, [option.settingId]: option.value });
  if (option.settingId === 'archivePolicy' && option.value === 'move') {
    await ensureDir(path.resolve(expandHome(state.settings.archiveDirectory)));
  }
  if (option.settingId === 'llmProvider') {
    resetModelCache(state.settingsPanel);
    if (option.value !== 'disabled') await refreshModels(controller, { quiet: true });
  }
  state.settingsPanel.optionIndex = findOptionIndex(state, option.id);
  state.status = `${option.label} selected`;
  controller.invalidate();
}

function openSettingModal(controller, fieldId, returnOptionId) {
  const field = settingsFieldDefinition(fieldId);
  if (!field) return;
  controller.state.settingsPanel.modal = { field, error: null, returnOptionId };
  controller.state.editor.set(settingsEditorValue(controller.state, fieldId));
  controller.state.status = field.label;
  controller.invalidate();
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
    if (!quiet) state.status = `${panel.models.length} ${providerDefinition(provider).label} models available`;
  } catch (error) {
    panel.models = [];
    panel.modelsProvider = provider;
    panel.modelError = error.message;
    if (!quiet) state.status = error.message;
  } finally {
    panel.loadingModels = false;
    panel.optionIndex = preferredOptionIndex(state);
    controller.invalidate();
  }
}

async function ensureDefinitionData(controller, definition) {
  const panel = controller.state.settingsPanel;
  if (definition.id === 'localLlm'
    && controller.state.settings.llmProvider !== 'disabled'
    && panel.modelsProvider !== controller.state.settings.llmProvider
    && !panel.loadingModels) await refreshModels(controller, { quiet: true });
}

async function validateSettingValue(field, entered) {
  if (field.id === 'archiveDirectory') {
    if (!entered) throw new Error('Enter an archive directory.');
    const absolute = path.resolve(expandHome(entered));
    await ensureDir(absolute);
    return entered;
  }
  if (field.id === 'archiveRetentionDays') {
    if (!/^\d+$/.test(entered)) throw new Error('Enter retention as a whole number of days.');
    const value = Number(entered);
    if (value > 36_500) throw new Error('Retention cannot exceed 36,500 days.');
    return value;
  }
  if (field.id === 'archiveMaxBytes') {
    const value = parseByteSize(entered);
    if (value > Number.MAX_SAFE_INTEGER) throw new Error('Archive size limit is too large.');
    return value;
  }
  if (field.id === 'llmApiToken') return entered;
  throw new Error(`Unsupported setting: ${field.id}`);
}

function currentDefinition(state) {
  const definitions = settingsDefinitions(state);
  const index = clamp(state.settingsPanel?.settingIndex ?? 0, 0, Math.max(0, definitions.length - 1));
  if (state.settingsPanel) state.settingsPanel.settingIndex = index;
  return definitions[index];
}

function optionsFor(state) {
  return settingsOptions(state, currentDefinition(state));
}

function preferredOptionIndex(state) {
  const definition = currentDefinition(state);
  const options = settingsOptions(state, definition);
  const selected = options.findIndex((option) => option.settingId === definition.primarySetting && option.selected);
  return selected >= 0 ? selected : moveOption(state, -1, 1);
}

function findOptionIndex(state, optionId) {
  const index = optionsFor(state).findIndex((option) => option.id === optionId);
  return index >= 0 ? index : preferredOptionIndex(state);
}

function moveOption(state, current, delta) {
  const options = optionsFor(state);
  if (!options.length) return 0;
  let next = current;
  for (let attempts = 0; attempts < options.length; attempts += 1) {
    next = wrap(next + delta, options.length);
    if (!options[next].disabled) return next;
  }
  return 0;
}

function resetModelCache(panel) {
  panel.models = [];
  panel.modelsProvider = null;
  panel.modelError = null;
}

function wrap(value, length) {
  return length ? (value + length) % length : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
