import { handleInputEditorKey } from 'terlio.js';

export function canSearchSettingsChoices(state) {
  return state.settingsPanel?.focus === 'choices' && state.settingsPanel?.activeParameterId === 'llmModel';
}

export function filterSettingsChoices(state, choices, parameter) {
  if (parameter?.id !== 'llmModel') return choices;
  const query = String(state.settingsPanel?.choiceSearch?.query ?? '').trim().toLowerCase();
  if (!query) return choices;
  const fixed = choices.filter((item) => item.action === 'refresh-models');
  const matching = choices.filter((item) => item.model
    && `${item.label} ${item.description ?? ''} ${item.model?.id ?? ''} ${item.model?.key ?? ''}`.toLowerCase().includes(query));
  return [...fixed, ...matching];
}

export function handleSettingsChoiceSearchKey(controller, key, moveChoice) {
  const { state } = controller;
  const search = state.settingsPanel.choiceSearch;
  if (key.name === 'escape') {
    if (state.searchEditor.value) {
      state.searchEditor.set('');
      search.query = '';
    } else search.active = false;
    state.settingsPanel.choiceIndices[state.settingsPanel.activeParameterId] = 0;
    controller.invalidate();
    return true;
  }
  if (key.name === 'enter') {
    search.active = false;
    controller.invalidate();
    return true;
  }
  if (key.name === 'up' || key.name === 'down') {
    moveChoice(key.name === 'up' ? -1 : 1);
    controller.invalidate();
    return true;
  }
  handleInputEditorKey(state.searchEditor, key, { multiline: false });
  search.query = state.searchEditor.value;
  state.settingsPanel.choiceIndices[state.settingsPanel.activeParameterId] = 0;
  controller.invalidate();
  return true;
}
