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
import { testSelectedModel } from './settings-model-check.js';
import {
  handleModelReplayWorkspaceKey, loadModelReplayRuns, startHistoricalModelReplay,
} from './settings-model-replay.js';
import { clearArchiveStorage, clearBackups, refreshSettingsStorage } from './settings-storage.js';
import {
  canSearchSettingsChoices, filterSettingsChoices, handleSettingsChoiceSearchKey,
} from './settings-choice-search.js';
import {
  settingsChoices, settingsDefinitions, settingsEditorValue, settingsFieldDefinition, settingsPageTitle, settingsParameters,
} from './settings-options.js';
import {
  clamp, currentChoiceIndex, currentChoices, currentDefinition, currentParameterIndex, directSettingParameter,
  enterSelectedCategory, isDirectDefinition, moveChoice, moveParameter, panelParameter, rememberParameter,
  restoreParameter, selectedChoiceIndex, setParameterIndex, wrap,
} from './settings-panel-state.js';

export function isSettingsScreen(screen) {
  return screen === 'settings';
}

export async function openSettings(controller, { categoryId = null } = {}) {
  const { state } = controller;
  if (state.busy || ['checks-running', 'deploy-running', 'manual-checks-running', 'manual-deploy-running'].includes(state.screen)) {
    controller.toast('Settings are available after this operation finishes', 'info');
    return false;
  }
  const history = state.project ? await loadManagedHistory(state.project.root) : { paths: [] };
  state.settingsPanel = {
    previous: {
      screen: state.screen,
      menuItems: state.menuItems,
      selectedIndex: state.selectedIndex,
      status: state.status,
    },
    focus: 'categories',
    categoryIndex: Math.max(0, settingsDefinitions(state).findIndex((item) => item.id === categoryId)),
    parameterIndices: {},
    choiceIndices: {},
    activeParameterId: null,
    models: [],
    modelsProvider: null,
    modelError: null,
    loadingModels: false,
    managedCount: history.paths.length,
    managedHistory: history,
    storageStats: null,
    loadingStorage: false,
    storageError: null,
    modal: null,
    modelConfig: null,
    choiceSearch: null,
    subpage: null,
  };
  setScreen(state, 'settings', { status: 'Global settings' });
  controller.invalidate();
  await refreshSettingsStorage(controller, { quiet: true });
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
    state.status = modal.field.label;
    controller.toast(`${modal.field.label} saved`, 'success');
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
  if (panel.modelTestWorkspace) return handleModelReplayWorkspaceKey(controller, key);
  if (panel.modelTest?.running && key.name === 'escape') {
    controller.state.settingsTestAbortController?.abort();
    controller.setStatus('Cancelling model test…');
    return true;
  }
  if (panel.modal) return handleModalKey(controller, key);
  if (panel.choiceSearch?.active) return handleSettingsChoiceSearchKey(controller, key, (delta) => moveChoice(controller.state, delta));
  if (key.name === 'tab') return toggleSettingsPane(controller);
  if (panel.focus?.startsWith('model-config')) return handleModelSettingsKey(controller, key);
  if (key.printable && key.text === '/' && canSearchSettingsChoices(controller.state)) {
    panel.choiceSearch = { active: true, query: '' };
    controller.state.searchEditor.set('');
    panel.choiceIndices[panel.activeParameterId] = 0;
    controller.invalidate();
    return true;
  }
  if (key.name === 'escape' || key.name === 'left') return handleBack(controller);
  if (key.name === 'up' || key.name === 'down') {
    const delta = key.name === 'up' ? -1 : 1;
    if (panel.focus === 'categories') await moveCategory(controller, delta);
    else if (panel.focus === 'parameters') moveParameter(controller.state, delta);
    else moveChoice(controller.state, delta);
    controller.invalidate();
    return true;
  }
  if (['enter', 'space', 'right'].includes(key.name)) {
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
  panel.modelConfig = null;
  panel.subpage = null;
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
  const choices = showChoices && activeParameter ? filterSettingsChoices(state, settingsChoices(state, activeParameter), activeParameter) : [];
  return {
    focus: state.settingsPanel?.focus ?? 'categories',
    definitions,
    selectedSetting,
    pageTitle: settingsPageTitle(state, selectedSetting),
    parameters,
    choices,
    activeParameter,
    direct: Boolean(directParameter),
    categoryIndex: state.settingsPanel?.categoryIndex ?? 0,
    parameterIndex,
    choiceIndex: currentChoiceIndex(state, choices, activeParameter),
    modal: state.settingsPanel?.modal ?? null,
    modelConfig: settingsModelView(state),
    choiceSearch: state.settingsPanel?.choiceSearch ?? null,
  };
}

function toggleSettingsPane(controller) {
  const { state } = controller;
  const panel = state.settingsPanel;
  if (panel.focus === 'categories') {
    if (panel.modelConfig) panel.focus = 'model-config';
    else enterSelectedCategory(state);
    state.status = currentDefinition(state).label;
  } else {
    panel.focus = 'categories';
    state.status = 'Global settings';
  }
  controller.invalidate();
  return true;
}

async function handleBack(controller) {
  const panel = controller.state.settingsPanel;
  if (panel.focus === 'choices') {
    panel.focus = isDirectDefinition(currentDefinition(controller.state)) ? 'categories' : 'parameters';
    panel.activeParameterId = null;
    panel.choiceSearch = null;
    controller.state.status = panel.focus === 'categories' ? 'Global settings' : currentDefinition(controller.state).label;
    controller.invalidate();
    return true;
  }
  if (panel.focus === 'parameters') {
    if (panel.subpage) {
      if (panel.subpage === 'llmModelReplay') {
        panel.subpage = 'llmModelTests';
        panel.parameterIndices[currentDefinition(controller.state).id] = 1;
        controller.state.status = 'Model tests';
      } else {
        const previousId = panel.subpage === 'llmLanguages' ? 'llmLanguages' : 'llmModelTests';
        panel.subpage = null;
        restoreParameter(controller.state, previousId);
        controller.state.status = currentDefinition(controller.state).label;
      }
    } else {
      panel.focus = 'categories';
      controller.state.status = 'Global settings';
    }
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
  state.settingsPanel.modelConfig = null;
  state.settingsPanel.subpage = null;
  await ensureDefinitionData(controller, currentDefinition(state));
  restoreParameter(state);
  state.status = currentDefinition(state).label;
}

async function enterCategory(controller) {
  const { state } = controller;
  state.settingsPanel.modelConfig = null;
  await ensureDefinitionData(controller, currentDefinition(state));
  enterSelectedCategory(state);
  state.status = currentDefinition(state).label;
  controller.invalidate();
  return true;
}

async function activateParameter(controller) {
  const { state } = controller;
  const parameter = panelParameter(state);
  if (!parameter || parameter.disabled || parameter.blocked) return true;
  rememberParameter(state, parameter.id);
  if (parameter.type === 'action') {
    if (parameter.action === 'storage-refresh') await refreshSettingsStorage(controller);
    else if (parameter.action === 'model-test-connection') await testSelectedModel(controller);
    else if (parameter.action === 'model-test-replay') {
      state.status = 'Loading historical updates';
      await loadModelReplayRuns(controller);
      state.settingsPanel.subpage = 'llmModelReplay';
      state.settingsPanel.parameterIndices[currentDefinition(state).id] = 0;
      state.status = 'Historical model replay';
      controller.invalidate();
    } else if (parameter.action === 'model-replay-run') {
      await startHistoricalModelReplay(controller, parameter.runId);
    } else if (parameter.action === 'model-replay-back') {
      state.settingsPanel.subpage = 'llmModelTests';
      state.settingsPanel.parameterIndices[currentDefinition(state).id] = 1;
      state.status = 'Model tests';
      controller.invalidate();
    } else if (parameter.action === 'subpage-back') {
      const previousId = state.settingsPanel.subpage === 'llmLanguages' ? 'llmLanguages' : 'llmModelTests';
      state.settingsPanel.subpage = null;
      restoreParameter(state, previousId);
      state.status = currentDefinition(state).label;
      controller.invalidate();
    }
    return true;
  }
  if (parameter.type === 'subpage') {
    state.settingsPanel.subpage = parameter.id;
    state.settingsPanel.focus = 'parameters';
    state.settingsPanel.parameterIndices[currentDefinition(state).id] = 0;
    state.status = parameter.label;
    controller.invalidate();
    return true;
  }
  if (parameter.type === 'input') {
    openSettingModal(controller, parameter.fieldId, parameter.id);
    return true;
  }
  state.settingsPanel.focus = 'choices';
  state.settingsPanel.activeParameterId = parameter.id;
  state.settingsPanel.choiceSearch = null;
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
  if (option.action === 'clear-cancel') return returnAfterChoice(controller, parameter.id, 'Nothing was deleted');
  if (option.action === 'archive-storage-clear-confirm') {
    await clearArchiveStorage(controller);
    return returnAfterChoice(controller, parameter.id, 'Source archive storage updated');
  }
  if (option.action === 'backup-storage-clear-confirm') {
    await clearBackups(controller);
    return returnAfterChoice(controller, parameter.id, 'Backup storage updated');
  }
  if (option.action === 'managed-history-clear-confirm') {
    const result = await resetManagedHistory(state.project.root);
    state.settingsPanel.managedHistory = { ...state.settingsPanel.managedHistory, paths: [], updatedAt: new Date().toISOString() };
    state.settingsPanel.managedCount = 0;
    return returnAfterChoice(controller, parameter.id, `${result.removed} managed path${result.removed === 1 ? '' : 's'} cleared`);
  }
  if (option.settingId) {
    state.settings = await saveSettings({
      ...state.settings,
      [option.settingId]: option.value,
      ...(['llmProvider', 'llmModel'].includes(option.settingId) ? { llmDecisionCompatibility: null } : {}),
    });
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
  state.status = currentDefinition(state).label;
  controller.toast(status, 'success');
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

