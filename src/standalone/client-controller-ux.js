import { normalizeZipflowKey } from '../app/key-normalization.js';
import { handleSetupShortcut } from '../app/setup-flow.js';
import { handleExportShortcut } from '../app/export-flow.js';
import {
  closeSettings,
  handleSettingsKey,
  isSettingsScreen,
  openSettings,
  selectChoice,
  selectModelSettingChoice,
  selectModelSettingParameter,
  selectParameter,
  selectSetting,
} from '../app/settings-panel.js';
import {
  beginMenuSearch,
  followLatestActivity,
  handleMenuSearchKey,
  showContextHelp,
} from '../app/controller-navigation.js';
import {
  isEditorScreen,
  isPagedMenuScreen,
  isSearchableScreen,
} from '../app/controller-screen-rules.js';
import { toggleActivityBlockAtRow, toggleActivityBlockAtScroll } from '../ui/activity.js';
import { handleReplayDispatch } from '../app/settings-model-replay.js';
import { handleUpdateDispatch, handleUpdateKey } from '../app/update-flow.js';
import { isScreenActionCurrent } from '../app/ui-action-context.js';
import {
  acceptPathSuggestion,
  movePathSuggestion,
  selectPathSuggestion,
} from '../app/path-suggestions.js';
import {
  handleClientReviewKey,
  handlesReviewScreen,
} from './client-review-flow.js';

export async function handleClientKey(controller, key) {
  const { state } = controller;
  state.inputGeneration = (Number(state.inputGeneration) || 0) + 1;
  const normalized = normalizeZipflowKey(key);
  if ((normalized.printable || ['backspace', 'delete'].includes(normalized.name))
    && (state.screen === 'archive-input' || isSettingsScreen(state.screen))) {
    state.pathSuggestionAbortController?.abort?.('superseded-input');
  }
  if (normalized.name === 'ctrl-c' || (normalized.ctrl && normalized.name === 'c')) {
    return controller.handleInterrupt();
  }
  if (state.updatePrompt) return handleUpdateKey(controller, normalized);
  if (state.menuSearch?.active) return handleMenuSearchKey(controller, normalized);
  if (normalized.ctrl && normalized.name === 't') {
    const pointerEnabled = controller.runtime?.togglePointerOverride?.();
    controller.setStatus(pointerEnabled === false
      ? 'Native text selection enabled · drag anywhere · Ctrl+T restores interactive controls'
      : 'Interactive pointer controls restored');
    return Promise.resolve();
  }
  if (normalized.ctrl && normalized.name === 'b') {
    return Promise.resolve(isSettingsScreen(state.screen)
      ? closeSettings(controller)
      : openSettings(controller));
  }
  if (isSettingsScreen(state.screen)) return handleSettingsKey(controller, normalized);
  if (isEditorScreen(state.screen)) return controller.handleEditorKey(normalized);
  if (handlesReviewScreen(state.screen)
    && await handleClientReviewKey(controller, normalized)) {
    return undefined;
  }
  if (handleSetupShortcut(controller, normalized)) {
    controller.invalidate();
    return Promise.resolve();
  }
  if (normalized.printable && normalized.text?.toLowerCase() === 'g' && controller.runId) {
    return controller.showReport();
  }
  if (normalized.printable && normalized.text === '?') {
    showContextHelp(controller);
    return Promise.resolve();
  }
  if ((normalized.name === 'page-up' || normalized.name === 'page-down')
    && isPagedMenuScreen(state.screen)) {
    controller.clearMenuActivationBarrier();
    controller.pageSelection(normalized.name === 'page-up' ? -1 : 1);
    controller.invalidate();
    return Promise.resolve();
  }
  if (normalized.name === 'page-up' || normalized.name === 'page-down') {
    const delta = normalized.name === 'page-up' ? -8 : 8;
    const maxScroll = state.activityLayout?.maxScroll ?? Number.MAX_SAFE_INTEGER;
    state.transcriptScroll = Math.max(0, Math.min(maxScroll, state.transcriptScroll + delta));
    state.transcriptSticky = state.transcriptScroll >= maxScroll;
    if (state.transcriptSticky) state.activityUnread = 0;
    controller.invalidate();
    return Promise.resolve();
  }
  if ((normalized.name === 'home' || normalized.name === 'end')
    && isPagedMenuScreen(state.screen)) {
    controller.clearMenuActivationBarrier();
    controller.jumpSelection(normalized.name === 'home' ? 'first' : 'last');
    controller.invalidate();
    return Promise.resolve();
  }
  if (normalized.name === 'end') {
    followLatestActivity(controller);
    controller.invalidate();
    return Promise.resolve();
  }
  if (normalized.printable && normalized.text === '/' && isSearchableScreen(state.screen)) {
    controller.clearMenuActivationBarrier();
    beginMenuSearch(controller);
    controller.invalidate();
    return Promise.resolve();
  }
  if (normalized.printable && normalized.text?.toLowerCase() === 'e'
    && toggleActivityBlockAtScroll(state)) {
    controller.setStatus('Activity block toggled');
    return Promise.resolve();
  }
  if (!state.busy && handleExportShortcut(controller, normalized)) {
    controller.invalidate();
    return Promise.resolve();
  }
  if (normalized.name === 'escape' && state.screen === 'archive-discovery') {
    return Promise.resolve(controller.promptArchive());
  }
  if (normalized.name === 'up' || normalized.name === 'down') {
    controller.clearMenuActivationBarrier();
    controller.moveSelection(normalized.name === 'up' ? -1 : 1);
    controller.invalidate();
    return Promise.resolve();
  }
  if (normalized.name === 'enter' || normalized.name === 'space') {
    return controller.inputActions.run(() => controller.activateSelected());
  }
  if (normalized.name === 'escape') {
    if (state.screen === 'diff-view') return controller.showPlan();
    return controller.back();
  }
  return Promise.resolve();
}

export async function dispatchClientAction(controller, action = {}) {
  const { state } = controller;
  if (!isScreenActionCurrent(state, action)) return false;
  if (await handleUpdateDispatch(controller, action)) return undefined;
  if (await handleReplayDispatch(controller, action)) return undefined;
  if (action.type === 'activity-toggle-row') {
    if (toggleActivityBlockAtRow(state, action.row)) controller.invalidate();
    return undefined;
  }
  if (action.type === 'settings-select-setting') return selectSetting(controller, action.index);
  if (action.type === 'settings-select-parameter') return selectParameter(controller, action.index);
  if (action.type === 'settings-select-choice') return selectChoice(controller, action.index);
  if (action.type === 'settings-model-select-parameter') {
    return selectModelSettingParameter(controller, action.index);
  }
  if (action.type === 'settings-model-select-choice') {
    return selectModelSettingChoice(controller, action.index);
  }
  if (action.type === 'settings-wheel') {
    const delta = Math.trunc(Number(action.delta) || 0);
    if (!delta) return undefined;
    const key = { name: delta < 0 ? 'up' : 'down', navigationWrap: action.wrap !== false };
    for (let index = 0; index < Math.abs(delta); index += 1) {
      await handleSettingsKey(controller, key);
    }
    return undefined;
  }
  if (action.type === 'path-move') {
    if (movePathSuggestion(state, Number(action.delta) || 0, {
      wrap: action.wrap !== false,
    })) controller.invalidate();
    return undefined;
  }
  if (action.type === 'path-select') {
    selectPathSuggestion(state, action.index);
    if (state.pathSuggestions?.owner === 'settings-modal') {
      await handleSettingsKey(controller, { name: 'enter' });
    } else {
      await acceptPathSuggestion(controller, {
        submit: () => controller.submitCurrentEditor(),
        submitSelected: false,
      });
    }
    return undefined;
  }
  if (action.type === 'activate-index') {
    state.selectedIndex = Math.max(0, Math.trunc(Number(action.index) || 0));
    return controller.inputActions.run(() => controller.activateSelected());
  }
  if (action.type === 'menu-move-selection') {
    controller.moveSelection(Number(action.delta) || 0, { wrap: action.wrap !== false });
    return controller.invalidate();
  }
  if (action.type === 'activity-follow-latest') {
    state.transcriptSticky = true;
    state.activityUnread = 0;
    return controller.invalidate();
  }
  return undefined;
}
