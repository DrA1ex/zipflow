import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'terlio.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { openModelConfiguration, selectModelChoice, selectModelParameter, settingsModelView } from '../src/app/settings-model.js';
import { settingsViewModel } from '../src/app/settings-panel.js';
import { listLocalModelChoices } from '../src/llm/client.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';
import { renderZipflow } from '../src/ui/render.js';
import { tempDir } from '../test-support/helpers.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function catalog() {
  return {
    models: [
      {
        type: 'llm', key: 'gemma-12b', display_name: 'Gemma 12B', params_string: '12B',
        max_context_length: 32_000, quantization: { name: 'Q4_K_M' }, loaded_instances: [],
      },
      {
        type: 'llm', key: 'qwen-27b', display_name: 'Qwen 27B', params_string: '27B',
        max_context_length: 65_536, quantization: { name: 'Q5_K_M' },
        loaded_instances: [{
          id: 'qwen-loaded',
          config: { context_length: 24_000, eval_batch_size: 512, flash_attention: true, offload_kv_cache_to_gpu: true },
        }],
      },
    ],
  };
}

async function models() {
  return listLocalModelChoices('lmstudio', { fetchImpl: async () => jsonResponse(catalog()) });
}

function settingsState(modelChoices) {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture' };
  state.screen = 'settings';
  state.settings = { ...DEFAULT_SETTINGS, llmProvider: 'lmstudio', llmModel: 'qwen-loaded' };
  state.settingsPanel = {
    focus: 'choices', categoryIndex: 2, parameterIndices: { localLlm: 1 }, choiceIndices: {},
    activeParameterId: 'llmModel', models: modelChoices, modelsProvider: 'lmstudio', modelError: null,
    loadingModels: false, managedCount: 0, modal: null, modelConfig: null,
    previous: { screen: 'home', menuItems: [], selectedIndex: 0, status: 'Ready' },
  };
  return state;
}

test('LM Studio model list uses radio selection and muted loaded state metadata', async () => {
  const state = settingsState(await models());
  const output = renderToString(renderZipflow({ state, width: 120, height: 32 }), { width: 120, height: 32 });

  assert.match(output, /○ Gemma 12B[\s\S]*12B · Q4_K_M[\s\S]*· Not loaded/);
  assert.match(output, /● Qwen 27B · 27B · Q5_K_M[\s\S]*· Loaded/);
  assert.match(output, /Context 24,000 · batch 512 · flash enabled · KV gpu memory/);
  assert.doesNotMatch(output, /just-in-time/i);
  assert.doesNotMatch(output, /Read the models currently exposed/i);
});


test('model refresh renders the Terlio inline spinner in the refresh row', async () => {
  const state = settingsState(await models());
  state.settingsPanel.loadingModels = true;
  state.uiAnimationFrame = 1;
  const output = renderToString(renderZipflow({ state, width: 120, height: 32 }), { width: 120, height: 32 });

  assert.match(output, /⠙ Refreshing available models/);
  assert.doesNotMatch(output, /Refreshing available models ×/);
});

test('model selection skips Refresh and model configuration starts on Save and select', async () => {
  const modelChoices = await models();
  const state = settingsState(modelChoices);
  state.settings.llmModel = '';
  let view = settingsViewModel(state);
  assert.equal(view.choices[view.choiceIndex].model.key, 'qwen-27b');

  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  openModelConfiguration(controller, modelChoices.find((item) => item.key === 'gemma-12b'));
  view = settingsModelView(state);
  assert.equal(view.parameters[view.parameterIndex].id, 'use-model');
  assert.equal(view.parameters[view.parameterIndex].label, 'Save and select');
  assert.equal(view.parameters.some((item) => /Use loaded instance/i.test(item.label)), false);
});

test('loaded LM Studio models allow configuration changes and reload the selected instance', async () => {
  const previousHome = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-loaded-model-context-home-');
  try {
    const modelChoices = await models();
    const state = settingsState(modelChoices);
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};
    const loaded = modelChoices.find((item) => item.key === 'qwen-27b');
    openModelConfiguration(controller, loaded);

    let view = settingsModelView(state);
    assert.equal(view.parameters.find((item) => item.id === 'contextLength').disabled, false);
    assert.equal(view.parameters.find((item) => item.id === 'evalBatchSize').disabled, false);
    await selectModelParameter(controller, view.parameters.findIndex((item) => item.id === 'contextLength'));
    view = settingsModelView(state);
    await selectModelChoice(controller, view.choices.findIndex((item) => item.value === 16_384));
    const requests = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url.endsWith('/models/unload')) return jsonResponse({});
      if (url.endsWith('/models/load')) return jsonResponse({
        instance_id: 'qwen-reloaded',
        load_config: { context_length: 16_384, eval_batch_size: 512, flash_attention: true, offload_kv_cache_to_gpu: true },
      });
      throw new Error(`Unexpected request: ${url}`);
    };
    try {
      view = settingsModelView(state);
      await selectModelParameter(controller, view.parameters.findIndex((item) => item.id === 'use-model'));
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.deepEqual(requests.map((item) => item.url.split('/').at(-1)), ['unload', 'load']);
    assert.equal(requests[0].body.instance_id, 'qwen-loaded');
    assert.equal(requests[1].body.model, 'qwen-27b');
    assert.equal(state.settings.llmModel, 'qwen-27b');
    assert.equal(state.settings.llmModelLoadConfigs['lmstudio:qwen-27b'].contextLength, 16_384);
  } finally {
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
  }
});

test('unloaded LM Studio models open load configuration and apply selected parameters', async () => {
  const previousHome = process.env.ZIPFLOW_HOME;
  const previousFetch = globalThis.fetch;
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-model-settings-home-');
  let requestBody = null;
  try {
    const modelChoices = await models();
    const state = settingsState(modelChoices);
    state.settings.llmModel = '';
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};
    const model = modelChoices.find((item) => item.key === 'gemma-12b');
    openModelConfiguration(controller, model);

    let view = settingsModelView(state);
    assert.equal(view.model.paramsString, '12B');
    assert.equal(view.parameters[0].id, 'contextLength');
    assert.equal(view.parameters.at(-2).id, 'use-model');

    await selectModelParameter(controller, 0);
    view = settingsModelView(state);
    const contextIndex = view.choices.findIndex((item) => item.value === 16_384);
    assert.notEqual(contextIndex, -1);
    await selectModelChoice(controller, contextIndex);

    const requests = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url.endsWith('/models/unload')) return jsonResponse({});
      if (url.endsWith('/models/load')) {
        requestBody = body;
        return jsonResponse({
          instance_id: 'gemma-custom',
          load_time_seconds: 1.2,
          load_config: { context_length: 16_384, eval_batch_size: 512, flash_attention: true },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    view = settingsModelView(state);
    const useIndex = view.parameters.findIndex((item) => item.id === 'use-model');
    await selectModelParameter(controller, useIndex);

    assert.deepEqual(requests.map((item) => item.url.split('/').at(-1)), ['unload', 'load']);
    assert.equal(requests[0].body.instance_id, 'qwen-loaded');
    assert.equal(requestBody.model, 'gemma-12b');
    assert.equal(requestBody.context_length, 16_384);
    assert.equal(requestBody.echo_load_config, true);
    assert.equal(state.settings.llmModel, 'gemma-12b');
    assert.equal(state.settingsPanel.models[0].loadedInstanceId, 'gemma-custom');
    assert.equal(state.settingsPanel.focus, 'choices');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
  }
});


test('LM Studio choices keep the catalog key as the selectable model ID', async () => {
  const choices = await listLocalModelChoices('lmstudio', { fetchImpl: async () => jsonResponse({
    models: [{
      type: 'llm', key: 'gemma-4-e4b-it-mlx', display_name: 'Gemma 4 E4B Instruct',
      loaded_instances: [{ id: 'gemma-4-e4b-it-mlx:2', config: { context_length: 32_768 } }],
    }],
  }) });

  assert.equal(choices.length, 1);
  assert.equal(choices[0].id, 'gemma-4-e4b-it-mlx');
  assert.equal(choices[0].key, 'gemma-4-e4b-it-mlx');
  assert.equal(choices[0].loadedInstanceId, 'gemma-4-e4b-it-mlx:2');
});
