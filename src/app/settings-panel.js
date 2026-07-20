import path from 'node:path';
import { handleInputEditorKey } from 'terlio.js';
import { loadManagedHistory, resetManagedHistory } from '../history/managed.js';
import { saveSettings } from '../settings/store.js';
import { ensureDir } from '../utils/fs.js';
import { expandHome } from '../utils/paths.js';
import { setScreen } from './state.js';
import {
  handleModelSettingsKey, openModelConfiguration, selectModelChoice, selectModelParameter, settingsModelView,
} from './settings-model.js';
import { ensureDefinitionData, ensureModels, refreshModels, resetModelCache } from './settings-model-list.js';
import {
  clearPathSuggestions, movePathSuggestion, refreshPathSuggestions, resetPathSuggestionInput, selectPathSuggestion,
} from './path-suggestions.js';
import { validateSettingValue } from './settings-validation.js';
import {
  settingsChoices, settingsDefinitions, settingsEditorValue, settingsFieldDefinition, settingsParameters,
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
    focus: 'categories',
    categoryIndex: 0,
    parameterIndices: {},
    choiceIndices: {},
    activeParameterId: null,
    models: [],
    modelsProvider: null,
    modelError: null,
    loadingModels: false,
    managedCount: history.paths.length,
    modal: null,
    modelConfig: null,
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
  resetPathSuggestionInput(controller.state);
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
  resetPathSuggestionInput(controller.state);
  controller.state.status = currentDefinition(controller.state).label;
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
    resetPathSuggestionInput(state);
    restoreParameter(state, modal.returnParameterId);
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
  if (panel.focus?.startsWith('model-config')) return handleModelSettingsKey(controller, key);
  if (key.name === 'escape' || key.name === 'left') return handleBack(controller);
  if (key.name === 'up' || key.name === 'down') {
    const delta = key.name === 'up' ? -1 : 1;
    if (panel.focus === 'categories') await moveCategory(controller, delta);
    else if (panel.focus === 'parameters') moveParameter(controller.state, delta);
    else moveChoice(controller.state, delta);
    controller.invalidate();
    return true;
  }
  if (['enter', 'space', 'right', 'tab'].includes(key.name)) {
    if (panel.focus === 'categories') return enterCategory(controller);
    if (panel.focus === 'parameters') return activateParameter(controller);
    return activateChoice(controller);
  }
  return true;
}

export async function selectSetting(controller, index) {
  const panel = controller.state.settingsPanel;
  if (!panel) return;
  panel.categoryIndex = clamp(index, 0, settingsDefinitions(controller.state).length - 1);
  await ensureDefinitionData(controller, currentDefinition(controller.state));
  enterSelectedCategory(controller.state);
  controller.state.status = currentDefinition(controller.state).label;
  controller.invalidate();
}

export async function selectParameter(controller, index) {
  const panel = controller.state.settingsPanel;
  if (!panel) return;
  panel.focus = 'parameters';
  setParameterIndex(controller.state, index);
  await activateParameter(controller);
}

export async function selectChoice(controller, index) {
  const panel = controller.state.settingsPanel;
  if (!panel || panel.focus !== 'choices') return;
  panel.choiceIndices[panel.activeParameterId] = clamp(index, 0, currentChoices(controller.state).length - 1);
  await activateChoice(controller);
}

export async function selectModelSettingParameter(controller, index) {
  return selectModelParameter(controller, index);
}

export async function selectModelSettingChoice(controller, index) {
  return selectModelChoice(controller, index);
}

export function settingsViewModel(state) {
  const definitions = settingsDefinitions(state);
  const selectedSetting = currentDefinition(state);
  const parameters = settingsParameters(state, selectedSetting);
  const parameterIndex = currentParameterIndex(state, parameters);
  const directParameter = directSettingParameter(selectedSetting, parameters);
  const activeParameter = directParameter ?? panelParameter(state, parameters);
  const showChoices = Boolean(directParameter) || state.settingsPanel?.focus === 'choices';
  const choices = showChoices && activeParameter ? settingsChoices(state, activeParameter) : [];
  return {
    focus: state.settingsPanel?.focus ?? 'categories',
    definitions,
    selectedSetting,
    parameters,
    choices,
    activeParameter,
    direct: Boolean(directParameter),
    categoryIndex: state.settingsPanel?.categoryIndex ?? 0,
    parameterIndex,
    choiceIndex: currentChoiceIndex(state, choices, activeParameter),
    modal: state.settingsPanel?.modal ?? null,
    modelConfig: settingsModelView(state),
  };
}

async function handleBack(controller) {
  const panel = controller.state.settingsPanel;
  if (panel.focus === 'choices') {
    panel.focus = isDirectDefinition(currentDefinition(controller.state)) ? 'categories' : 'parameters';
    panel.activeParameterId = null;
    controller.state.status = panel.focus === 'categories' ? 'Global settings' : currentDefinition(controller.state).label;
    controller.invalidate();
    return true;
  }
  if (panel.focus === 'parameters') {
    panel.focus = 'categories';
    controller.state.status = 'Global settings';
    controller.invalidate();
    return true;
  }
  closeSettings(controller);
  return true;
}

async function moveCategory(controller, delta) {
  const { state } = controller;
  const definitions = settingsDefinitions(state);
  state.settingsPanel.categoryIndex = wrap(state.settingsPanel.categoryIndex + delta, definitions.length);
  await ensureDefinitionData(controller, currentDefinition(state));
  restoreParameter(state);
  state.status = currentDefinition(state).label;
}

async function enterCategory(controller) {
  const { state } = controller;
  await ensureDefinitionData(controller, currentDefinition(state));
  enterSelectedCategory(state);
  state.status = currentDefinition(state).label;
  controller.invalidate();
  return true;
}

async function activateParameter(controller) {
  const { state } = controller;
  const parameter = panelParameter(state);
  if (!parameter || parameter.disabled) return true;
  rememberParameter(state, parameter.id);
  if (parameter.type === 'input') {
    openSettingModal(controller, parameter.fieldId, parameter.id);
    return true;
  }
  state.settingsPanel.focus = 'choices';
  state.settingsPanel.activeParameterId = parameter.id;
  if (parameter.settingId === 'llmModel' && state.settings.llmProvider !== 'disabled') {
    await ensureModels(controller);
  }
  const choices = settingsChoices(state, parameter);
  state.settingsPanel.choiceIndices[parameter.id] = selectedChoiceIndex(state, choices, parameter);
  state.status = parameter.label;
  controller.invalidate();
  return true;
}

async function activateChoice(controller) {
  const { state } = controller;
  const parameter = panelParameter(state);
  const choices = currentChoices(state);
  const index = currentChoiceIndex(state, choices, parameter);
  const option = choices[index];
  if (!parameter || !option || option.disabled) return true;
  if (option.action === 'configure-model') {
    openModelConfiguration(controller, option.model);
    return true;
  }
  if (option.action === 'refresh-models') {
    await refreshModels(controller);
    const refreshed = currentChoices(state);
    state.settingsPanel.choiceIndices[parameter.id] = selectedChoiceIndex(state, refreshed, parameter);
    controller.invalidate();
    return true;
  }
  if (option.action === 'history-cancel') return returnAfterChoice(controller, parameter.id, 'Managed-file history was not changed');
  if (option.action === 'history-reset-confirm') {
    const result = await resetManagedHistory(state.project.root);
    state.settingsPanel.managedCount = 0;
    controller.message('Managed-file history reset', [`${result.removed} recorded paths removed.`], 'warning');
    return returnAfterChoice(controller, parameter.id, 'Managed-file history reset');
  }
  if (option.settingId) {
    state.settings = await saveSettings({ ...state.settings, [option.settingId]: option.value });
    if (option.settingId === 'archivePolicy' && option.value === 'move') {
      await ensureDir(path.resolve(expandHome(state.settings.archiveDirectory)));
    }
    if (option.settingId === 'llmProvider') {
      resetModelCache(state.settingsPanel);
      if (option.value !== 'disabled') await refreshModels(controller, { quiet: true });
    }
    return returnAfterChoice(controller, parameter.id, `${option.label} selected`);
  }
  return true;
}

function returnAfterChoice(controller, parameterId, status) {
  const { state } = controller;
  if (isDirectDefinition(currentDefinition(state))) {
    state.settingsPanel.focus = 'choices';
    state.settingsPanel.activeParameterId = parameterId;
    const parameter = panelParameter(state);
    const choices = parameter ? settingsChoices(state, parameter) : [];
    state.settingsPanel.choiceIndices[parameterId] = selectedChoiceIndex(state, choices, parameter);
  } else {
    state.settingsPanel.focus = 'parameters';
    state.settingsPanel.activeParameterId = null;
    restoreParameter(state, parameterId);
  }
  state.status = status;
  controller.invalidate();
  return true;
}

async function handleModalKey(controller, key) {
  const { state } = controller;
  const modal = state.settingsPanel.modal;
  if (key.name === 'escape') {
    backSettingsEditor(controller);
    return true;
  }
  if (modal.field.path && (key.name === 'up' || key.name === 'down') && state.pathSuggestions?.items?.length) {
    movePathSuggestion(state, key.name === 'up' ? -1 : 1);
    controller.invalidate();
    return true;
  }
  if (modal.field.path && ['tab', 'enter'].includes(key.name) && state.pathSuggestions?.items?.length) {
    selectPathSuggestion(state, state.pathSuggestions.selectedIndex);
    const item = state.pathSuggestions.items[state.pathSuggestions.selectedIndex];
    state.editor.set(item.insert);
    if (item.submit) return submitSettingsEditor(controller);
    await refreshPathSuggestions(controller, { settingsModal: true });
    return true;
  }
  if (key.name === 'enter') return submitSettingsEditor(controller);
  modal.error = null;
  const previousValue = state.editor.value;
  handleInputEditorKey(state.editor, key, { multiline: false });
  if (modal.field.path && state.editor.value !== previousValue) {
    state.pathSuggestionActive = Boolean(String(state.editor.value ?? '').trim());
    await refreshPathSuggestions(controller, { settingsModal: true });
  }
  controller.invalidate();
  return true;
}

function openSettingModal(controller, fieldId, returnParameterId) {
  const field = settingsFieldDefinition(fieldId);
  if (!field) return;
  controller.state.settingsPanel.modal = { field, error: null, returnParameterId };
  controller.state.editor.set(settingsEditorValue(controller.state, fieldId));
  resetPathSuggestionInput(controller.state);
  controller.state.status = field.label;
  controller.invalidate();
}

function currentDefinition(state) {
  const definitions = settingsDefinitions(state);
  const index = clamp(state.settingsPanel?.categoryIndex ?? 0, 0, Math.max(0, definitions.length - 1));
  if (state.settingsPanel) state.settingsPanel.categoryIndex = index;
  return definitions[index];
}

function panelParameter(state, parameters = null) {
  const items = parameters ?? settingsParameters(state, currentDefinition(state));
  if (!items.length) return null;
  return items[currentParameterIndex(state, items)] ?? items[0];
}

function currentParameterIndex(state, parameters = null) {
  const items = parameters ?? settingsParameters(state, currentDefinition(state));
  const categoryId = currentDefinition(state).id;
  const index = clamp(state.settingsPanel?.parameterIndices?.[categoryId] ?? 0, 0, Math.max(0, items.length - 1));
  if (state.settingsPanel) state.settingsPanel.parameterIndices[categoryId] = index;
  return index;
}

function setParameterIndex(state, index) {
  const items = settingsParameters(state, currentDefinition(state));
  state.settingsPanel.parameterIndices[currentDefinition(state).id] = clamp(index, 0, Math.max(0, items.length - 1));
}

function moveParameter(state, delta) {
  const items = settingsParameters(state, currentDefinition(state));
  if (!items.length) return;
  let index = currentParameterIndex(state, items);
  for (let attempts = 0; attempts < items.length; attempts += 1) {
    index = wrap(index + delta, items.length);
    if (!items[index].disabled) break;
  }
  setParameterIndex(state, index);
}

function moveChoice(state, delta) {
  const choices = currentChoices(state);
  if (!choices.length) return;
  const parameter = panelParameter(state);
  let index = currentChoiceIndex(state, choices, parameter);
  for (let attempts = 0; attempts < choices.length; attempts += 1) {
    index = wrap(index + delta, choices.length);
    if (!choices[index].disabled) break;
  }
  state.settingsPanel.choiceIndices[parameter.id] = index;
}

function currentChoices(state) {
  const parameter = panelParameter(state);
  return parameter ? settingsChoices(state, parameter) : [];
}

function currentChoiceIndex(state, choices, parameter) {
  if (!parameter || !choices.length) return 0;
  const saved = state.settingsPanel?.choiceIndices?.[parameter.id];
  if (Number.isInteger(saved) && choices[saved] && !choices[saved].disabled) return saved;
  return selectedChoiceIndex(state, choices, parameter);
}

function selectedChoiceIndex(state, choices, parameter) {
  const selected = choices.findIndex((item) => item.settingId === parameter.settingId
    && (item.value === state.settings[parameter.settingId] || item.selected));
  if (selected >= 0) return selected;
  if (parameter.settingId === 'llmModel') {
    const firstModel = choices.findIndex((item) => item.model && !item.disabled);
    if (firstModel >= 0) return firstModel;
  }
  return choices.findIndex((item) => !item.disabled) >= 0 ? choices.findIndex((item) => !item.disabled) : 0;
}

function rememberParameter(state, parameterId) {
  restoreParameter(state, parameterId);
}

function restoreParameter(state, parameterId = null) {
  const items = settingsParameters(state, currentDefinition(state));
  const categoryId = currentDefinition(state).id;
  if (parameterId) {
    const index = items.findIndex((item) => item.id === parameterId);
    if (index >= 0) state.settingsPanel.parameterIndices[categoryId] = index;
  }
  currentParameterIndex(state, items);
}

function enterSelectedCategory(state) {
  const definition = currentDefinition(state);
  restoreParameter(state);
  if (isDirectDefinition(definition)) {
    const parameter = panelParameter(state);
    state.settingsPanel.focus = 'choices';
    state.settingsPanel.activeParameterId = parameter?.id ?? null;
    if (parameter) {
      const choices = settingsChoices(state, parameter);
      state.settingsPanel.choiceIndices[parameter.id] = currentChoiceIndex(state, choices, parameter);
    }
  } else {
    state.settingsPanel.focus = 'parameters';
    state.settingsPanel.activeParameterId = null;
  }
}

function directSettingParameter(definition, parameters) {
  if (!definition?.directParameterId) return null;
  return parameters.find((item) => item.id === definition.directParameterId) ?? null;
}

function isDirectDefinition(definition) {
  return Boolean(definition?.directParameterId);
}

function wrap(value, length) {
  return length ? (value + length) % length : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
