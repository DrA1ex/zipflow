import { handleInputEditorKey } from 'terlio.js';
import { refreshMenuSearch } from './state.js';

export function showContextHelp(controller) {
  const { state } = controller;
  const item = state.menuItems[state.selectedIndex];
  if (!item) return;
  const summary = item.context || item.description || 'No additional description is available for this action.';
  const lines = [summary];
  if (item.help && item.help !== summary) lines.push('', item.help);
  state.helpToast = {
    title: `Help · ${item.label}`,
    lines,
    level: 'info',
    expiresAt: Date.now() + 12_000,
  };
  controller.invalidate();
}

export function beginMenuSearch(controller) {
  const { state } = controller;
  const previousQuery = state.menuSearch?.screen === state.screen ? state.menuSearch.query : '';
  state.menuSearch = { screen: state.screen, query: previousQuery, active: true };
  state.searchEditor.set(previousQuery);
  refreshMenuSearch(state, previousQuery);
}

export function handleMenuSearchKey(controller, key) {
  const { state } = controller;
  if (key.name === 'escape') {
    if (state.searchEditor.value) {
      state.searchEditor.set('');
      refreshMenuSearch(state, '');
    } else {
      state.menuSearch.active = false;
    }
    return controller.invalidate();
  }
  if (key.name === 'enter') {
    state.menuSearch.active = false;
    return controller.invalidate();
  }
  if (key.name === 'up' || key.name === 'down') {
    controller.moveSelection(key.name === 'up' ? -1 : 1);
    return controller.invalidate();
  }
  handleInputEditorKey(state.searchEditor, key, { multiline: false });
  refreshMenuSearch(state, state.searchEditor.value);
  return controller.invalidate();
}

export function followLatestActivity(controller) {
  const { state } = controller;
  const maxScroll = state.activityLayout?.maxScroll ?? state.transcriptScroll;
  state.transcriptScroll = Math.max(0, maxScroll);
  state.transcriptSticky = true;
  state.activityUnread = 0;
}
