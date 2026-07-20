import { filterSettingsChoices } from './settings-choice-search.js';
import { settingsChoices, settingsDefinitions, settingsParameters } from './settings-options.js';

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
  let index = clamp(state.settingsPanel?.parameterIndices?.[categoryId] ?? 0, 0, Math.max(0, items.length - 1));
  if (items[index]?.disabled) {
    const enabled = items.findIndex((item) => !item.disabled);
    if (enabled >= 0) index = enabled;
  }
  if (state.settingsPanel) state.settingsPanel.parameterIndices[categoryId] = index;
  return index;
}

export function setParameterIndex(state, index) {
  const items = settingsParameters(state, currentDefinition(state));
  state.settingsPanel.parameterIndices[currentDefinition(state).id] = clamp(index, 0, Math.max(0, items.length - 1));
}

export function moveParameter(state, delta) {
  const items = settingsParameters(state, currentDefinition(state));
  if (!items.length) return;
  let index = currentParameterIndex(state, items);
  for (let attempts = 0; attempts < items.length; attempts += 1) {
    index = wrap(index + delta, items.length);
    if (!items[index].disabled) break;
  }
  setParameterIndex(state, index);
}

export function moveChoice(state, delta) {
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

export function currentChoices(state) {
  const parameter = panelParameter(state);
  return parameter ? filterSettingsChoices(state, settingsChoices(state, parameter), parameter) : [];
}

export function currentChoiceIndex(state, choices, parameter) {
  if (!parameter || !choices.length) return 0;
  const saved = state.settingsPanel?.choiceIndices?.[parameter.id];
  if (Number.isInteger(saved) && choices[saved] && !choices[saved].disabled) return saved;
  return selectedChoiceIndex(state, choices, parameter);
}

export function selectedChoiceIndex(state, choices, parameter) {
  const selected = choices.findIndex((item) => item.settingId === parameter.settingId
    && (item.value === state.settings[parameter.settingId] || item.selected));
  if (selected >= 0) return selected;
  if (parameter.settingId === 'llmModel') {
    const firstModel = choices.findIndex((item) => item.model && !item.disabled);
    if (firstModel >= 0) return firstModel;
  }
  const enabled = choices.findIndex((item) => !item.disabled);
  return enabled >= 0 ? enabled : 0;
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
