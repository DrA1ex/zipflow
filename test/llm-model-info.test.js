import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocalModelProfile } from '../src/llm/model-info.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

test('LM Studio profile uses the loaded instance context and reasoning capabilities', async () => {
  const fetchImpl = async () => jsonResponse({
    models: [{
      type: 'llm', key: 'gemma', max_context_length: 131_072,
      loaded_instances: [{ id: 'custom-instance', config: { context_length: 32_000 } }],
      capabilities: { reasoning: { allowed_options: ['off', 'on'], default: 'on' } },
    }],
  });

  const profile = await getLocalModelProfile('lmstudio', 'custom-instance', { fetchImpl });
  assert.equal(profile.contextLength, 32_000);
  assert.equal(profile.maxContextLength, 131_072);
  assert.equal(profile.reasoningOffSupported, true);
  assert.equal(profile.source, 'loaded-instance');
  assert.equal(profile.requestModel, 'custom-instance');
  assert.equal(profile.loadedModel, true);
});

test('LM Studio profile falls back to maximum context for an unloaded model', async () => {
  const fetchImpl = async () => jsonResponse({
    models: [{ type: 'llm', key: 'gemma', max_context_length: 65_536, loaded_instances: [] }],
  });

  const profile = await getLocalModelProfile('lmstudio', 'gemma', { fetchImpl });
  assert.equal(profile.contextLength, 65_536);
  assert.equal(profile.source, 'model-metadata');
  assert.equal(profile.requestModel, 'gemma');
  assert.equal(profile.loadedModel, false);
});

test('Ollama profile prefers the actually allocated running context', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/ps')) return jsonResponse({ models: [{ model: 'qwen', context_length: 12_288 }] });
    return jsonResponse({ parameters: 'num_ctx 4096', model_info: { 'qwen.context_length': 131_072 } });
  };

  const profile = await getLocalModelProfile('ollama', 'qwen', { fetchImpl });
  assert.equal(profile.contextLength, 12_288);
  assert.equal(profile.maxContextLength, 131_072);
  assert.equal(profile.source, 'running-model');
});

test('Ollama profile uses model num_ctx when the model is not running', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
    return jsonResponse({ parameters: 'temperature 0\nnum_ctx 8192', model_info: { 'qwen.context_length': 131_072 } });
  };

  const profile = await getLocalModelProfile('ollama', 'qwen', { fetchImpl });
  assert.equal(profile.contextLength, 8_192);
  assert.equal(profile.source, 'model-parameters');
});

test('model profile uses a conservative fallback when metadata endpoints fail', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const profile = await getLocalModelProfile('lmstudio', 'missing', { fetchImpl });
  assert.equal(profile.contextLength, 16_384);
  assert.equal(profile.source, 'fallback');
});
