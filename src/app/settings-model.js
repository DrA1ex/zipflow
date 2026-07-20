import { loadLmStudioModel } from '../llm/client.js';
import { saveSettings } from '../settings/store.js';

export function openModelConfiguration(controller, model) {
  const { state } = controller;
  const saved = savedConfig(state, model);
  const values = model.loaded
    ? { ...configFromLoaded(model), ...saved }
    : { ...defaultConfig(), ...saved };
  state.settingsPanel.focus = 'model-config';
  state.settingsPanel.modelConfig = {
    model,
    focus: 'parameters',
    parameterIndex: useModelParameterIndex(model, values),
    choiceIndex: 0,
    activeParameterId: null,
    values,
    loading: false,
    error: null,
  };
  state.status = 'Model configuration';
  controller.invalidate();
}

export function settingsModelView(state) {
  const modelConfig = state.settingsPanel?.modelConfig;
  if (!modelConfig || !state.settingsPanel?.focus?.startsWith('model-config')) return null;
  const parameters = modelParameters(modelConfig);
  const parameterIndex = clamp(modelConfig.parameterIndex, 0, Math.max(0, parameters.length - 1));
  modelConfig.parameterIndex = parameterIndex;
  const activeParameter = parameters[parameterIndex] ?? null;
  const choices = modelConfig.focus === 'choices' && activeParameter
    ? parameterChoices(modelConfig, activeParameter)
    : [];
  modelConfig.choiceIndex = clamp(modelConfig.choiceIndex, 0, Math.max(0, choices.length - 1));
  return {
    ...modelConfig,
    parameters,
    parameterIndex,
    activeParameter,
    choices,
    choiceIndex: modelConfig.choiceIndex,
  };
}

export async function handleModelSettingsKey(controller, key) {
  const config = controller.state.settingsPanel?.modelConfig;
  if (!config) return false;
  if (key.name === 'escape' || key.name === 'left') {
    if (config.focus === 'choices') return backToModelParameters(controller);
    return closeModelConfiguration(controller);
  }
  if (key.name === 'up' || key.name === 'down') {
    const delta = key.name === 'up' ? -1 : 1;
    if (config.focus === 'choices') moveModelChoice(config, delta, settingsModelView(controller.state).choices.length);
    else moveModelParameter(config, delta, settingsModelView(controller.state).parameters.length);
    controller.invalidate();
    return true;
  }
  if (['enter', 'space', 'right', 'tab'].includes(key.name)) {
    if (config.focus === 'choices') return activateModelChoice(controller);
    return activateModelParameter(controller);
  }
  return true;
}

export async function selectModelParameter(controller, index) {
  const config = controller.state.settingsPanel?.modelConfig;
  if (!config) return;
  config.focus = 'parameters';
  config.parameterIndex = index;
  await activateModelParameter(controller);
}

export async function selectModelChoice(controller, index) {
  const config = controller.state.settingsPanel?.modelConfig;
  if (!config) return;
  config.choiceIndex = index;
  await activateModelChoice(controller);
}

function modelParameters(config) {
  const model = config.model;
  const values = config.values;
  const parameters = [
    valueParameter('contextLength', 'Context length', tokenLabel(values.contextLength), false),
    valueParameter('evalBatchSize', 'Evaluation batch', numberLabel(values.evalBatchSize), model.loaded),
    valueParameter('flashAttention', 'Flash Attention', triStateLabel(values.flashAttention), model.loaded),
    valueParameter('offloadKvCacheToGpu', 'KV cache', kvLabel(values.offloadKvCacheToGpu), model.loaded),
  ];
  if (values.numExperts != null || model.config?.num_experts != null) {
    parameters.push(valueParameter('numExperts', 'Experts', numberLabel(values.numExperts), model.loaded));
  }
  parameters.push({ id: 'use-model', action: 'use-model', label: 'Use this model', value: '' });
  parameters.push({ id: 'back-models', action: 'back-models', label: 'Back to model list', value: '' });
  return parameters;
}

function parameterChoices(config, parameter) {
  if (parameter.id === 'contextLength') return contextChoices(config.model);
  if (parameter.id === 'evalBatchSize') return [null, 128, 256, 512, 1024, 2048].map((value) => valueChoice(parameter.id, value, numberLabel(value)));
  if (parameter.id === 'flashAttention') return triStateChoices(parameter.id, 'Automatic', 'Enabled', 'Disabled');
  if (parameter.id === 'offloadKvCacheToGpu') return triStateChoices(parameter.id, 'Automatic', 'GPU memory', 'CPU memory');
  if (parameter.id === 'numExperts') return [null, 1, 2, 4, 8, 16].map((value) => valueChoice(parameter.id, value, numberLabel(value)));
  return [];
}

async function activateModelParameter(controller) {
  const view = settingsModelView(controller.state);
  const parameter = view?.activeParameter;
  if (!parameter || parameter.disabled) return true;
  if (parameter.action === 'back-models') return closeModelConfiguration(controller);
  if (parameter.action === 'use-model') return useConfiguredModel(controller);
  const config = controller.state.settingsPanel.modelConfig;
  config.focus = 'choices';
  config.activeParameterId = parameter.id;
  const choices = parameterChoices(config, parameter);
  config.choiceIndex = Math.max(0, choices.findIndex((item) => item.value === config.values[parameter.id]));
  controller.state.status = parameter.description;
  controller.invalidate();
  return true;
}

function activateModelChoice(controller) {
  const config = controller.state.settingsPanel.modelConfig;
  const view = settingsModelView(controller.state);
  const option = view.choices[view.choiceIndex];
  if (!option) return true;
  config.values[config.activeParameterId] = option.value;
  config.focus = 'parameters';
  config.activeParameterId = null;
  controller.state.status = `${view.activeParameter.label} updated`;
  controller.invalidate();
  return true;
}

async function useConfiguredModel(controller) {
  const { state } = controller;
  const config = state.settingsPanel.modelConfig;
  const model = config.model;
  if (config.loading) return true;
  config.loading = true;
  config.error = null;
  state.status = model.loaded ? 'Selecting loaded model' : 'Loading model in LM Studio';
  controller.invalidate();
  try {
    let selectedId = model.id;
    let appliedConfig = config.values;
    if (!model.loaded && state.settings.llmProvider === 'lmstudio') {
      const loaded = await loadLmStudioModel(model.key, config.values, { apiToken: state.settings.llmApiToken });
      selectedId = loaded.instanceId;
      appliedConfig = { ...config.values, ...normalizeApiConfig(loaded.config) };
    }
    const configKey = modelConfigKey(state.settings.llmProvider, model.key);
    state.settings = await saveSettings({
      ...state.settings,
      llmModel: selectedId,
      llmModelLoadConfigs: {
        ...(state.settings.llmModelLoadConfigs ?? {}),
        [configKey]: appliedConfig,
      },
    });
    if (!model.loaded) {
      const updated = {
        ...model,
        id: selectedId,
        loaded: true,
        contextLength: appliedConfig.contextLength ?? model.maxContextLength ?? null,
        config: {
          context_length: appliedConfig.contextLength,
          eval_batch_size: appliedConfig.evalBatchSize,
          flash_attention: appliedConfig.flashAttention,
          offload_kv_cache_to_gpu: appliedConfig.offloadKvCacheToGpu,
          num_experts: appliedConfig.numExperts,
        },
      };
      state.settingsPanel.models = [
        updated,
        ...state.settingsPanel.models.filter((item) => item.id !== selectedId && item.key !== model.key),
      ];
    }
    state.settingsPanel.modelsProvider = state.settings.llmProvider;
    delete state.settingsPanel.choiceIndices.llmModel;
    state.settingsPanel.modelConfig = null;
    state.settingsPanel.focus = 'choices';
    state.settingsPanel.activeParameterId = 'llmModel';
    state.status = model.loaded ? 'Model selected' : 'Model loaded and selected';
  } catch (error) {
    config.error = error.message;
    state.status = error.message;
  } finally {
    if (state.settingsPanel.modelConfig) state.settingsPanel.modelConfig.loading = false;
    controller.invalidate();
  }
  return true;
}

function closeModelConfiguration(controller) {
  const panel = controller.state.settingsPanel;
  panel.modelConfig = null;
  panel.focus = 'choices';
  panel.activeParameterId = 'llmModel';
  controller.state.status = 'Model';
  controller.invalidate();
  return true;
}

function backToModelParameters(controller) {
  const config = controller.state.settingsPanel.modelConfig;
  config.focus = 'parameters';
  config.activeParameterId = null;
  controller.state.status = 'Model configuration';
  controller.invalidate();
  return true;
}

function savedConfig(state, model) {
  return state.settings.llmModelLoadConfigs?.[modelConfigKey(state.settings.llmProvider, model.key)] ?? {};
}

export function modelConfigKey(provider, modelKey) {
  return `${provider}:${modelKey}`;
}

export function modelConfigSummary(state, model) {
  const saved = savedConfig(state, model);
  if (model.loaded) return configSummary({ ...configFromLoaded(model), ...saved });
  return Object.keys(saved).length ? configSummary({ ...defaultConfig(), ...saved }) : '';
}

function configFromLoaded(model) {
  const source = model.config ?? {};
  return {
    contextLength: source.context_length ?? model.contextLength ?? null,
    evalBatchSize: source.eval_batch_size ?? null,
    flashAttention: source.flash_attention ?? null,
    offloadKvCacheToGpu: source.offload_kv_cache_to_gpu ?? null,
    numExperts: source.num_experts ?? null,
  };
}

function defaultConfig() {
  return { contextLength: null, evalBatchSize: null, flashAttention: null, offloadKvCacheToGpu: null, numExperts: null };
}

function useModelParameterIndex(model, values) {
  return 4 + Number(values.numExperts != null || model.config?.num_experts != null);
}

function normalizeApiConfig(config) {
  return {
    contextLength: config.context_length ?? null,
    evalBatchSize: config.eval_batch_size ?? null,
    flashAttention: config.flash_attention ?? null,
    offloadKvCacheToGpu: config.offload_kv_cache_to_gpu ?? null,
    numExperts: config.num_experts ?? null,
  };
}

function contextChoices(model) {
  const maximum = Number(model.maxContextLength ?? 0) || null;
  const candidates = [null, 4096, 8192, 16384, 32768, 65536, 131072];
  if (maximum && !candidates.includes(maximum)) candidates.push(maximum);
  return candidates.filter((value) => value === null || !maximum || value <= maximum)
    .sort((left, right) => (left ?? 0) - (right ?? 0))
    .map((value) => valueChoice('contextLength', value, value === null ? 'Automatic' : tokenLabel(value)));
}

function triStateChoices(id, autoLabel, onLabel, offLabel) {
  return [valueChoice(id, null, autoLabel), valueChoice(id, true, onLabel), valueChoice(id, false, offLabel)];
}

function valueParameter(id, label, value, disabled) {
  return { id, label, value, disabled, description: modelParameterHelp(id) };
}

function valueChoice(id, value, label) {
  return { id: `${id}:${String(value)}`, value, label };
}

function modelParameterHelp(id) {
  if (id === 'contextLength') return 'Maximum prompt and response context used by this model instance.';
  if (id === 'evalBatchSize') return 'Input tokens processed together; larger values can be faster but use more memory.';
  if (id === 'flashAttention') return 'Attention optimization that can improve speed and reduce memory use.';
  if (id === 'offloadKvCacheToGpu') return 'Keep the KV cache in GPU memory or system RAM.';
  return 'Number of active experts used by a mixture-of-experts model.';
}

function configSummary(values) {
  const parts = [
    `context ${tokenLabel(values.contextLength)}`,
    `batch ${numberLabel(values.evalBatchSize)}`,
    `flash ${triStateLabel(values.flashAttention).toLowerCase()}`,
    `KV ${kvLabel(values.offloadKvCacheToGpu).toLowerCase()}`,
  ];
  if (values.numExperts != null) parts.push(`experts ${values.numExperts}`);
  return parts.join(' · ');
}

function tokenLabel(value) {
  return value ? Number(value).toLocaleString('en-US') : 'Automatic';
}

function numberLabel(value) {
  return value ? Number(value).toLocaleString('en-US') : 'Automatic';
}

function triStateLabel(value) {
  return value === true ? 'Enabled' : value === false ? 'Disabled' : 'Automatic';
}

function kvLabel(value) {
  return value === true ? 'GPU memory' : value === false ? 'CPU memory' : 'Automatic';
}

function moveModelParameter(config, delta, length) {
  config.parameterIndex = wrap(config.parameterIndex + delta, length);
}

function moveModelChoice(config, delta, length) {
  config.choiceIndex = wrap(config.choiceIndex + delta, length);
}

function wrap(value, length) {
  return length ? (value + length) % length : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
