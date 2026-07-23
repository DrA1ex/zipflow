import { filterSettingsChoices } from './settings-choice-search.js';
import { settingsChoices, settingsDefinitions, settingsParameters } from './settings-options.js';
import { moveSelectableIndex, nearestSelectableIndex, normalizeSelectableIndex } from './list-navigation.js';

export function currentDefinition(state) {
  const definitions = settingsDefinitions(state);
  const index = clamp(state.settingsPanel?.categoryIndex ?? 0, 0, Math.max(0, definitions.length - 1));
  if (state.settingsPanel) state.settingsPanel.categoryIndex = index;
  return definitions[index];
}

export function panelParameter(state, parameters = null) {
  const items = parameters ?? settingsParameters(state, currentDefinition(state));
  if (!items.length) return null;
  return items[currentParameterIndex(state, items)] ?? items[0];
}

export function currentParameterIndex(state, parameters = null) {
  const items = parameters ?? settingsParameters(state, currentDefinition(state));
  const categoryId = currentDefinition(state).id;
  let index = normalizeSelectableIndex(items, state.settingsPanel?.parameterIndices?.[categoryId] ?? 0);
  if (state.settingsPanel) state.settingsPanel.parameterIndices[categoryId] = index;
  return index;
}

export function setParameterIndex(state, index, { preferDirection = 1 } = {}) {
  const items = settingsParameters(state, currentDefinition(state));
  state.settingsPanel.parameterIndices[currentDefinition(state).id] = normalizeSelectableIndex(items, index, { preferDirection });
}

export function moveParameter(state, delta, { wrap = true } = {}) {
  const items = settingsParameters(state, currentDefinition(state));
  if (!items.length) return;
  const index = moveSelectableIndex(items, currentParameterIndex(state, items), delta, { wrap });
  setParameterIndex(state, index, { preferDirection: Math.sign(delta) || 1 });
}

export function moveChoice(state, delta, { wrap = true } = {}) {
  const choices = currentChoices(state);
  if (!choices.length) return;
  const parameter = panelParameter(state);
  state.settingsPanel.choiceIndices[parameter.id] = moveSelectableIndex(
    choices,
    currentChoiceIndex(state, choices, parameter),
    delta,
    { wrap },
  );
}

export function currentChoices(state) {
  const parameter = panelParameter(state);
  return parameter ? filterSettingsChoices(state, settingsChoices(state, parameter), parameter) : [];
}

export function currentChoiceIndex(state, choices, parameter) {
  if (!parameter || !choices.length) return 0;
  const saved = state.settingsPanel?.choiceIndices?.[parameter.id];
  if (Number.isInteger(saved)) return normalizeSelectableIndex(choices, saved);
  return selectedChoiceIndex(state, choices, parameter);
}

export function selectedChoiceIndex(state, choices, parameter) {
  const selected = choices.findIndex((item) => item.settingId === parameter.settingId
    && (item.value === state.settings[parameter.settingId] || item.selected));
  if (selected >= 0) return normalizeSelectableIndex(choices, selected);
  if (parameter.settingId === 'llmModel') {
    const firstModel = choices.findIndex((item) => item.model && !item.disabled);
    if (firstModel >= 0) return firstModel;
  }
  return nearestSelectableIndex(choices, selected >= 0 ? selected : 0) ?? 0;
}

export function rememberParameter(state, parameterId) {
  restoreParameter(state, parameterId);
}

export function restoreParameter(state, parameterId = null) {
  const items = settingsParameters(state, currentDefinition(state));
  const categoryId = currentDefinition(state).id;
  if (parameterId) {
    const index = items.findIndex((item) => item.id === parameterId);
    if (index >= 0) state.settingsPanel.parameterIndices[categoryId] = index;
  }
  currentParameterIndex(state, items);
}

export function enterSelectedCategory(state) {
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

export function directSettingParameter(definition, parameters) {
  if (!definition?.directParameterId) return null;
  return parameters.find((item) => item.id === definition.directParameterId) ?? null;
}

export function isDirectDefinition(definition) {
  return Boolean(definition?.directParameterId);
}

export function wrap(value, length) {
  return length ? (value + length) % length : 0;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
