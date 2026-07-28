import path from 'node:path';
import { handleInputEditorKey } from 'terlio.js';
import { isModifiedEnter, isPlainEnter } from './editor-enter.js';
import { loadManagedHistory, resetManagedHistory } from '../history/managed.js';
import { updateSettings } from '../settings/store.js';
import { loadLlmTokenStats, resetLlmTokenStats } from '../llm/token-stats.js';
import { ensureDir } from '../utils/fs.js';
import { expandHome } from '../utils/paths.js';
import { setScreen } from './state.js';
import { configureI18n } from '../i18n/index.js';
import { openHelpOverlay } from '../ui/help-overlay.js';
import {
  handleModelSettingsKey, openModelConfiguration, selectModelChoice, selectModelParameter, settingsModelView,
} from './settings-model.js';
import { ensureDefinitionData as ensureModelDefinitionData, ensureModels, refreshModels, resetModelCache } from './settings-model-list.js';
import {
  clearPathSuggestions, movePathSuggestion, navigatePathSuggestionParent, refreshPathSuggestions, resetPathSuggestionInput, selectPathSuggestion,
} from './path-suggestions.js';
import { validateSettingValue } from './settings-validation.js';
import { pageSelectableIndex } from './list-navigation.js';
import { OperationBusyError } from '../operations/manager.js';
import { showOperationBusy } from './operation-feedback.js';
import { testSelectedModel } from './settings-model-check.js';
import {
  handleModelReplayWorkspaceKey, loadModelReplayRuns, startHistoricalModelReplay,
} from './settings-model-replay.js';
import {
  loadAutopilotReplayRuns, startHistoricalAutopilotSimulation,
} from './settings-autopilot-replay.js';
import { clearArchiveStorage, clearBackups, refreshSettingsStorage } from './settings-storage.js';
import { checkForUpdatesNow } from './update-flow.js';
import {
  refreshSettingsBinaries, resetBinaryToAutomatic, saveBinaryPath, useDetectedBinary,
} from './settings-binaries.js';
import {
  canSearchSettingsChoices, filterSettingsChoices, handleSettingsChoiceSearchKey,
} from './settings-choice-search.js';
import {
  settingsChoices, settingsDefinitions, settingsEditorValue, settingsFieldDefinition, settingsPageHelp, settingsPageTitle, settingsParameters,
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
  if (!state.operationCapabilities?.canOpenSettings) {
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
    updateChecking: false,
    binaries: {},
    detectedBinaries: {},
    loadingBinaries: false,
    binaryError: null,
    tokenStats: null,
    tokenStatsLoading: false,
    tokenStatsError: null,
    modal: null,
    modelConfig: null,
    modelPromptView: null,
    choiceSearch: null,
    subpage: null,
  };
  setScreen(state, 'settings', { status: 'Global settings' });
  controller.invalidate();
  await Promise.all([
    refreshSettingsStorage(controller, { quiet: true }),
    refreshSettingsBinaries(controller, { quiet: true }),
    refreshLlmTokenStats(controller, { quiet: true }),
  ]);
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
    if (modal.field.binaryId) await saveBinaryPath(controller, modal.field.binaryId, value);
    else state.settings = await updateSettings({ [modal.field.id]: value }, { allowClearToken: modal.field.id === 'llmApiToken', baseSettings: state.settings });
    if (['llmApiToken', 'llmBaseUrl', 'llmCodexEndpoint'].includes(modal.field.id)) resetModelCache(state.settingsPanel);
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
  if (panel.modelPromptView) return handleModelPromptViewKey(controller, key);
  if (panel.modelTestWorkspace) return handleModelReplayWorkspaceKey(controller, key);
  if (panel.modelTest?.running && key.name === 'escape') {
    if (!panel.modelTest.cancellationRequested) {
      panel.modelTest.cancellationRequested = true;
      panel.modelTestEscapeGuardUntil = Number.POSITIVE_INFINITY;
      controller.state.settingsTestAbortController?.abort();
      controller.setStatus('Cancelling model test…');
    }
    return true;
  }
  if (key.name === 'escape' && Number(panel.modelTestEscapeGuardUntil ?? 0) > Date.now()) {
    return true;
  }
  if (controller.state.activeOperation && settingsKeyCanMutate(key)) {
    showOperationBusy(controller, new OperationBusyError('settings action', controller.state.activeOperation.kind));
    return true;
  }
  if (panel.modal) return handleModalKey(controller, key);
  if (panel.choiceSearch?.active) return handleSettingsChoiceSearchKey(controller, key, (delta) => moveChoice(controller.state, delta));
  if (key.printable && key.text === '?') return showSettingsHelp(controller);
  if (panel.focus?.startsWith('model-config')) return handleModelSettingsKey(controller, key);
  if (key.name === 'page-up' || key.name === 'page-down') return pageSettingsSelection(controller, key.name === 'page-up' ? -1 : 1);
  if (key.name === 'tab') return toggleSettingsPane(controller);
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
    const wrapNavigation = key.navigationWrap !== false;
    if (panel.focus === 'categories') await moveCategory(controller, delta, { wrap: wrapNavigation });
    else if (panel.focus === 'parameters') moveParameter(controller.state, delta, { wrap: wrapNavigation });
    else moveChoice(controller.state, delta, { wrap: wrapNavigation });
    controller.invalidate();
    return true;
  }
  if (isPlainEnter(key) || key.name === 'space' || key.name === 'right') {
    if (panel.focus === 'categories') return enterCategory(controller);
    if (panel.focus === 'parameters') return activateParameter(controller);
    return activateChoice(controller);
  }
  return true;
}

function settingsKeyCanMutate(key) {
  return !(key.printable && key.text === '?');
}

async function pageSettingsSelection(controller, direction) {
  const { state } = controller;
  const panel = state.settingsPanel;
  const amount = 6;
  if (panel.focus === 'categories') {
    const definitions = settingsDefinitions(state);
    panel.categoryIndex = clamp(panel.categoryIndex + direction * amount, 0, Math.max(0, definitions.length - 1));
    panel.modelConfig = null;
    panel.subpage = null;
    await ensureDefinitionData(controller, currentDefinition(state));
  } else if (panel.focus === 'parameters') {
    const parameters = settingsParameters(state, currentDefinition(state));
    setParameterIndex(state, pageSelectableIndex(parameters, currentParameterIndex(state, parameters), direction, amount), { preferDirection: direction });
  } else {
    const parameter = panelParameter(state);
    const choices = currentChoices(state);
    if (parameter && choices.length) {
      const current = currentChoiceIndex(state, choices, parameter);
      panel.choiceIndices[parameter.id] = pageSelectableIndex(choices, current, direction, amount);
    }
  }
  controller.invalidate();
  return true;
}

function showSettingsHelp(controller) {
  const { state } = controller;
  const panel = state.settingsPanel;
  const definition = currentDefinition(state);
  let title = definition.label;
  const sections = [];
  const seen = new Set();
  const addSection = (...values) => {
    const lines = values.flat()
      .map((value) => String(value ?? '').trim())
      .filter((line) => line && !seen.has(line));
    for (const line of lines) seen.add(line);
    if (lines.length) sections.push(lines);
  };
  addSection(definition.description, definition.help);
  if (panel.focus === 'parameters') {
    const parameter = panelParameter(state) ?? definition;
    title = parameter.label ?? definition.label;
    addSection(parameter.description, parameter.help);
    if (parameter.disabledReason) addSection(parameter.disabledReason);
  } else if (panel.focus === 'choices') {
    const parameter = panelParameter(state);
    const choices = currentChoices(state);
    const choice = choices[currentChoiceIndex(state, choices, parameter)] ?? null;
    title = parameter?.label ?? definition.label;
    addSection(parameter?.description, parameter?.help);
    if (parameter?.disabledReason) addSection(parameter.disabledReason);
    addSection(choice?.description, choice?.help);
    if (choice?.disabledReason) addSection(choice.disabledReason);
  } else if (panel.focus?.startsWith('model-config')) {
    const item = settingsModelView(state)?.activeParameter ?? definition;
    title = item.label ?? definition.label;
    addSection(item.description, item.help);
    if (item.disabledReason) addSection(item.disabledReason);
  }
  addSection(settingsPageHelp(state, definition));
  const lines = sections.length
    ? sections.flatMap((section, index) => [...(index ? [''] : []), ...section])
    : ['No additional help is available.'];
  return openHelpOverlay(controller, { title: `Help · ${title}`, lines });
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
  const locked = Boolean(state.activeOperation);
  const lockItems = (items) => locked ? items.map((item) => ({
    ...item,
    disabled: true,
    disabledReason: item.disabledReason || `Wait for ${state.activeOperation?.label || 'the active operation'} to finish.`,
  })) : items;
  const definitions = lockItems(settingsDefinitions(state));
  const selectedSetting = definitions[state.settingsPanel?.categoryIndex ?? 0] ?? currentDefinition(state);
  const parameters = lockItems(settingsParameters(state, selectedSetting));
  const parameterIndex = currentParameterIndex(state, parameters);
  const directParameter = directSettingParameter(selectedSetting, parameters);
  const activeParameter = directParameter ?? panelParameter(state, parameters);
  const showChoices = Boolean(directParameter) || state.settingsPanel?.focus === 'choices';
  const choices = showChoices && activeParameter ? lockItems(filterSettingsChoices(state, settingsChoices(state, activeParameter), activeParameter)) : [];
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
function subpageOriginParameterId(subpage) {
  if (subpage === 'llmTasks') return 'llmTasks';
  if (subpage === 'llmLanguages') return 'llmLanguages';
  if (subpage === 'llmTokenStats') return 'llmTokenStats';
  return 'llmModelTests';
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
      if (panel.subpage === 'llmModelReplay' || panel.subpage === 'llmAutopilotReplay') {
        const previousIndex = panel.subpage === 'llmAutopilotReplay' ? 2 : 1;
        panel.subpage = 'llmModelTests';
        panel.parameterIndices[currentDefinition(controller.state).id] = previousIndex;
        controller.state.status = 'Model tests';
      } else {
        const previousId = subpageOriginParameterId(panel.subpage);
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
async function ensureDefinitionData(controller, definition) {
  await ensureModelDefinitionData(controller, definition);
  if (definition?.id === 'binaries') await refreshSettingsBinaries(controller, { quiet: true });
}

async function moveCategory(controller, delta, { wrap: wrapNavigation = true } = {}) {
  const { state } = controller;
  const definitions = settingsDefinitions(state);
  state.settingsPanel.categoryIndex = wrapNavigation
    ? wrap(state.settingsPanel.categoryIndex + delta, definitions.length)
    : clamp(state.settingsPanel.categoryIndex + delta, 0, Math.max(0, definitions.length - 1));
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
  if (parameter.type === 'action' || parameter.type === 'toggle') {
    if (parameter.action === 'toggle-setting') {
      state.settings = await updateSettings({ [parameter.settingId]: !parameter.selected }, { baseSettings: state.settings });
      if (parameter.settingId === 'llmUseExternalCodexServer') resetModelCache(state.settingsPanel);
      state.status = parameter.label;
      controller.invalidate();
    } else if (parameter.action === 'storage-refresh') await refreshSettingsStorage(controller);
    else if (parameter.action === 'update-check-now') await checkForUpdatesNow(controller);
    else if (parameter.action === 'binary-check-all') {
      await refreshSettingsBinaries(controller);
      const statuses = Object.values(state.settingsPanel?.binaries ?? {});
      const valid = statuses.filter((item) => item.valid).length;
      controller.toast(`${valid}/${statuses.length} executables available`, valid === statuses.length ? 'success' : 'warning');
    } else if (parameter.action === 'llm-token-stats-reset') {
      state.settingsPanel.tokenStatsLoading = true;
      state.settingsPanel.tokenStatsError = null;
      controller.invalidate();
      try {
        state.settingsPanel.tokenStats = await resetLlmTokenStats();
        controller.toast('LLM token statistics reset', 'success');
      } catch (error) {
        state.settingsPanel.tokenStatsError = error?.message ?? String(error);
        controller.toast('Could not reset LLM token statistics', 'error');
      } finally {
        state.settingsPanel.tokenStatsLoading = false;
        controller.invalidate();
      }
    } else if (parameter.action === 'model-test-connection') await testSelectedModel(controller);
    else if (parameter.action === 'model-test-prompt-view') {
      const prompt = state.settingsPanel.modelTest?.prompts?.[parameter.promptIndex];
      if (prompt) {
        state.settingsPanel.modelPromptView = { prompt, scroll: 0, maxScroll: 0 };
        state.status = prompt.label || 'Model test prompt';
        controller.invalidate();
      }
    } else if (parameter.action === 'model-test-replay') {
      state.status = 'Loading historical updates';
      await loadModelReplayRuns(controller);
      state.settingsPanel.subpage = 'llmModelReplay';
      state.settingsPanel.parameterIndices[currentDefinition(state).id] = 0;
      state.status = 'Historical model replay';
      controller.invalidate();
    } else if (parameter.action === 'model-replay-run') {
      await startHistoricalModelReplay(controller, parameter.runId);
    } else if (parameter.action === 'model-test-autopilot') {
      state.status = 'Loading historical updates';
      await loadAutopilotReplayRuns(controller);
      state.settingsPanel.subpage = 'llmAutopilotReplay';
      state.settingsPanel.parameterIndices[currentDefinition(state).id] = 0;
      state.status = 'Historical autopilot simulation';
      controller.invalidate();
    } else if (parameter.action === 'autopilot-replay-run') {
      await startHistoricalAutopilotSimulation(controller, parameter.runId);
    } else if (parameter.action === 'model-replay-back') {
      state.settingsPanel.subpage = 'llmModelTests';
      state.settingsPanel.parameterIndices[currentDefinition(state).id] = 1;
      state.status = 'Model tests';
      controller.invalidate();
    } else if (parameter.action === 'autopilot-replay-back') {
      state.settingsPanel.subpage = 'llmModelTests';
      state.settingsPanel.parameterIndices[currentDefinition(state).id] = 2;
      state.status = 'Model tests';
      controller.invalidate();
    } else if (parameter.action === 'subpage-back') {
      const previousId = subpageOriginParameterId(state.settingsPanel.subpage);
      state.settingsPanel.subpage = null;
      restoreParameter(state, previousId);
      state.status = currentDefinition(state).label;
      controller.invalidate();
    }
    return true;
  }
  if (parameter.type === 'subpage') {
    state.settingsPanel.subpage = parameter.id;
    if (parameter.id === 'llmTokenStats') await refreshLlmTokenStats(controller);
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
  if (option.action === 'refresh-languages') {
    state.i18n = await configureI18n(state.settings.interfaceLanguage);
    return returnAfterChoice(controller, parameter.id, 'Language packs refreshed');
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
  if (option.action === 'binary-use-detected') {
    const result = await useDetectedBinary(controller, option.binaryId);
    return returnAfterChoice(controller, parameter.id, `${result.label} path saved`);
  }
  if (option.action === 'binary-choose-path') {
    openSettingModal(controller, `binaryPath:${option.binaryId}`, parameter.id);
    return true;
  }
  if (option.action === 'binary-reset-auto') {
    const result = await resetBinaryToAutomatic(controller, option.binaryId);
    return returnAfterChoice(controller, parameter.id, result?.valid ? `${result.label} uses automatic detection` : 'Automatic detection reset');
  }
  if (option.settingId) {
    const settingPatch = option.settingId === 'llmProvider' && option.value !== state.settings.llmProvider
      ? { llmProvider: option.value, llmModel: '' }
      : { [option.settingId]: option.value };
    state.settings = await updateSettings(settingPatch, { baseSettings: state.settings });
    if (option.settingId === 'archivePolicy' && option.value === 'move') {
      await ensureDir(path.resolve(expandHome(state.settings.archiveDirectory)));
    }
    if (option.settingId === 'interfaceLanguage') {
      state.i18n = await configureI18n(option.value);
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
  const reverseTab = (key.name === 'tab' && key.shift) || key.name === 'backtab' || key.name === 'shift-tab';
  if (modal.field.path && reverseTab) {
    await navigatePathSuggestionParent(controller, { settingsModal: true });
    controller.invalidate();
    return true;
  }
  if (modal.field.path && (key.name === 'up' || key.name === 'down') && state.pathSuggestions?.items?.length) {
    movePathSuggestion(state, key.name === 'up' ? -1 : 1);
    controller.invalidate();
    return true;
  }
  if (modal.field.path && ((key.name === 'tab' && !key.shift) || isPlainEnter(key)) && state.pathSuggestions?.items?.length) {
    selectPathSuggestion(state, state.pathSuggestions.selectedIndex);
    const item = state.pathSuggestions.items[state.pathSuggestions.selectedIndex];
    state.editor.set(item.insert);
    if (item.submit) return submitSettingsEditor(controller);
    await refreshPathSuggestions(controller, { settingsModal: true });
    return true;
  }
  if (isPlainEnter(key)) return submitSettingsEditor(controller);
  if (isModifiedEnter(key)) return true;
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



function handleModelPromptViewKey(controller, key) {
  const view = controller.state.settingsPanel?.modelPromptView;
  if (!view) return false;
  if (key.name === 'escape' || key.name === 'left') {
    controller.state.settingsPanel.modelPromptView = null;
    controller.state.status = view.returnStatus || (controller.state.settingsPanel?.modelTestWorkspace?.status ?? 'Model tests');
    controller.invalidate();
    return true;
  }
  const page = ['page-up', 'pageup'].includes(key.name) ? -8
    : ['page-down', 'pagedown'].includes(key.name) ? 8
      : key.name === 'up' ? -1 : key.name === 'down' ? 1 : null;
  if (page != null) {
    view.scroll = clamp((view.scroll ?? 0) + page, 0, view.maxScroll ?? 0);
    controller.invalidate();
    return true;
  }
  if (key.name === 'home') {
    view.scroll = 0;
    controller.invalidate();
    return true;
  }
  if (key.name === 'end') {
    view.scroll = view.maxScroll ?? 0;
    controller.invalidate();
    return true;
  }
  return true;
}


async function refreshLlmTokenStats(controller, { quiet = false } = {}) {
  const panel = controller.state.settingsPanel;
  if (!panel || panel.tokenStatsLoading) return;
  panel.tokenStatsLoading = true;
  panel.tokenStatsError = null;
  if (!quiet) controller.invalidate();
  try {
    panel.tokenStats = await loadLlmTokenStats();
  } catch (error) {
    panel.tokenStatsError = error?.message ?? String(error);
  } finally {
    panel.tokenStatsLoading = false;
    controller.invalidate();
  }
}
