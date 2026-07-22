import { openHelpOverlay } from '../ui/help-overlay.js';
import { handleInputEditorKey } from 'terlio.js';
import { refreshMenuSearch } from './state.js';

export function showContextHelp(controller) {
  const { state } = controller;
  const selected = state.menuItems?.[state.selectedIndex];
  const title = selected?.label || state.editorContext?.label || state.status || 'Help';
  const summary = selected?.context || selected?.disabledReason || selected?.description || state.editorContext?.context
    || state.editorContext?.instructions?.join(' ') || 'No additional help is available.';
  const details = selected?.help && selected.help !== summary ? ['', selected.help] : [];
  return openHelpOverlay(controller, { title: `Help · ${title.replace(/\s*›\s*$/, '')}`, lines: [summary, ...details] });
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
