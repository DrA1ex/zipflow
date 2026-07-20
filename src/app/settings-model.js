import { loadLmStudioModel, unloadLmStudioModel } from '../llm/client.js';
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
    parameterIndex: saveModelParameterIndex(model, values),
    choiceIndex: 0,
    activeParameterId: null,
    values,
    loading: false,
    progressLabel: '',
    error: null,
  };
  state.status = 'Model configuration';
  controller.invalidate();
}

export function settingsModelView(state) {
  const modelConfig = state.settingsPanel?.modelConfig;
  if (!modelConfig) return null;
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
  if (config.loading) return true;
  if (key.name === 'escape' || key.name === 'left') {
    if (config.focus === 'choices') return backToModelParameters(controller);
    return closeModelConfiguration(controller);
  }
  if (key.name === 'up' || key.name === 'down') {
    const delta = key.name === 'up' ? -1 : 1;
    const view = settingsModelView(controller.state);
    if (config.focus === 'choices') moveModelChoice(config, delta, view.choices.length);
    else moveModelParameter(config, delta, view.parameters.length);
    controller.invalidate();
    return true;
  }
  if (['enter', 'space', 'right'].includes(key.name)) {
    if (config.focus === 'choices') return activateModelChoice(controller);
    return activateModelParameter(controller);
  }
  return true;
}

export async function selectModelParameter(controller, index) {
  const config = controller.state.settingsPanel?.modelConfig;
  if (!config || config.loading) return;
  config.focus = 'parameters';
  config.parameterIndex = index;
  await activateModelParameter(controller);
}

export async function selectModelChoice(controller, index) {
  const config = controller.state.settingsPanel?.modelConfig;
  if (!config || config.loading) return;
  config.choiceIndex = index;
  await activateModelChoice(controller);
}

function modelParameters(config) {
  const model = config.model;
  const values = config.values;
  const parameters = [
    valueParameter('contextLength', 'Context length', tokenLabel(values.contextLength)),
    valueParameter('evalBatchSize', 'Evaluation batch', numberLabel(values.evalBatchSize)),
    valueParameter('flashAttention', 'Flash Attention', triStateLabel(values.flashAttention)),
    valueParameter('offloadKvCacheToGpu', 'KV cache', kvLabel(values.offloadKvCacheToGpu)),
  ];
  if (values.numExperts != null || model.config?.num_experts != null) {
    parameters.push(valueParameter('numExperts', 'Experts', numberLabel(values.numExperts)));
  }
  parameters.push({
    id: 'use-model', action: 'use-model', label: config.loading ? (config.progressLabel || 'Applying…') : 'Save and select', value: '',
    description: 'Save these parameters, make this the selected model, and keep only its LLM instance loaded.',
    loading: config.loading,
    blocked: config.loading,
  });
  parameters.push({
    id: 'back-models', action: 'back-models', label: 'Back to model list', value: '',
    description: 'Discard unsaved parameter changes and return to available models.', blocked: config.loading,
  });
  return parameters;
}

function parameterChoices(config, parameter) {
  if (parameter.id === 'contextLength') return contextChoices(config.model);
  if (parameter.id === 'evalBatchSize') return [null, 128, 256, 512, 1024, 2048]
    .map((value) => valueChoice(parameter.id, value, numberLabel(value)));
  if (parameter.id === 'flashAttention') return triStateChoices(parameter.id, 'Automatic', 'Enabled', 'Disabled');
  if (parameter.id === 'offloadKvCacheToGpu') return triStateChoices(parameter.id, 'Automatic', 'GPU memory', 'CPU memory');
  if (parameter.id === 'numExperts') return [null, 1, 2, 4, 8, 16]
    .map((value) => valueChoice(parameter.id, value, numberLabel(value)));
  return [];
}

async function activateModelParameter(controller) {
  const view = settingsModelView(controller.state);
  const parameter = view?.activeParameter;
  if (!parameter || parameter.disabled || parameter.blocked) return true;
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
  config.progressLabel = 'Applying model configuration…';
  config.error = null;
  state.status = config.progressLabel;
  controller.invalidate();
  try {
    const result = state.settings.llmProvider === 'lmstudio'
      ? await reconcileLmStudioModel(controller, model, config)
      : { instanceId: null, config: config.values };
    const configKey = modelConfigKey(state.settings.llmProvider, model.key);
    state.settings = await saveSettings({
      ...state.settings,
      llmModel: model.key,
      llmSelectedInstanceId: result.instanceId,
      llmModelLoadConfigs: {
        ...(state.settings.llmModelLoadConfigs ?? {}),
        [configKey]: result.config,
      },
    });
    applyLoadedModelState(state, model, result);
    state.settingsPanel.modelsProvider = state.settings.llmProvider;
    delete state.settingsPanel.choiceIndices.llmModel;
    state.settingsPanel.modelConfig = null;
    state.settingsPanel.focus = 'choices';
    state.settingsPanel.activeParameterId = 'llmModel';
    state.status = 'Model saved and selected';
    controller.toast(`${model.label} selected`, 'success');
  } catch (error) {
    config.error = error.message;
    state.status = error.message;
  } finally {
    if (state.settingsPanel.modelConfig) {
      state.settingsPanel.modelConfig.loading = false;
      state.settingsPanel.modelConfig.progressLabel = '';
    }
    controller.invalidate();
  }
  return true;
}

async function reconcileLmStudioModel(controller, model, config) {
  const { state } = controller;
  const loadedIds = uniqueLoadedInstanceIds(state.settingsPanel.models);
  const sameSingleInstance = loadedIds.length === 1
    && loadedIds[0] === model.loadedInstanceId
    && configsEqual(config.values, configFromLoaded(model));
  if (sameSingleInstance) {
    return { instanceId: model.loadedInstanceId, config: { ...config.values } };
  }
  for (const instanceId of loadedIds) {
    config.progressLabel = `Unloading ${instanceId}…`;
    state.status = config.progressLabel;
    controller.invalidate();
    await unloadLmStudioModel(instanceId, { apiToken: state.settings.llmApiToken });
    state.settingsPanel.models = state.settingsPanel.models.map((item) => item.loadedInstanceIds?.includes(instanceId)
      ? { ...item, loaded: false, loadedInstanceId: null, loadedInstanceIds: [], config: {}, contextLength: null }
      : item);
  }
  config.progressLabel = `Loading ${model.label}…`;
  state.status = config.progressLabel;
  controller.invalidate();
  const loaded = await loadLmStudioModel(model.key, config.values, { apiToken: state.settings.llmApiToken });
  return {
    instanceId: loaded.instanceId,
    config: { ...config.values, ...normalizeApiConfig(loaded.config) },
  };
}

function applyLoadedModelState(state, selectedModel, result) {
  if (state.settings.llmProvider !== 'lmstudio') return;
  state.settingsPanel.models = state.settingsPanel.models.map((item) => {
    if (item.key !== selectedModel.key) {
      return { ...item, loaded: false, loadedInstanceId: null, loadedInstanceIds: [], config: {}, contextLength: null };
    }
    return {
      ...item,
      id: item.key,
      loaded: true,
      loadedInstanceId: result.instanceId,
      loadedInstanceIds: result.instanceId ? [result.instanceId] : [],
      contextLength: result.config.contextLength ?? item.maxContextLength ?? null,
      config: apiConfigFromValues(result.config),
    };
  }).sort((left, right) => Number(right.loaded) - Number(left.loaded) || left.label.localeCompare(right.label));
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

function saveModelParameterIndex(model, values) {
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

function apiConfigFromValues(config) {
  return {
    context_length: config.contextLength,
    eval_batch_size: config.evalBatchSize,
    flash_attention: config.flashAttention,
    offload_kv_cache_to_gpu: config.offloadKvCacheToGpu,
    num_experts: config.numExperts,
  };
}

function configsEqual(left, right) {
  return ['contextLength', 'evalBatchSize', 'flashAttention', 'offloadKvCacheToGpu', 'numExperts']
    .every((key) => (left[key] ?? null) === (right[key] ?? null));
}

function uniqueLoadedInstanceIds(models) {
  return [...new Set((models ?? []).flatMap((item) => item.loadedInstanceIds ?? [item.loadedInstanceId]).filter(Boolean))];
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

function valueParameter(id, label, value) {
  return { id, label, value, disabled: false, description: modelParameterHelp(id) };
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
