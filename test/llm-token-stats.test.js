import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createLocalCompletion } from '../src/llm/client.js';
import {
  emptyLlmTokenStats, loadLlmTokenStats, normalizeCompletionUsage, resetLlmTokenStats,
} from '../src/llm/token-stats.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings/store.js';
import { settingsDefinitions, settingsParameters } from '../src/app/settings-options.js';

test('token usage normalization reads Codex last-turn usage and estimates missing metadata', () => {
  assert.deepEqual(normalizeCompletionUsage({
    total: { inputTokens: 1000, outputTokens: 200 },
    last: { inputTokens: 120, outputTokens: 30 },
    modelContextWindow: 262144,
  }), {
    requests: 1, inputTokens: 120, outputTokens: 30, exactRequests: 1, estimatedRequests: 0,
  });

  const estimated = normalizeCompletionUsage(null, {
    messages: [{ role: 'user', content: 'A moderately long prompt for token estimation.' }],
    completion: { content: 'A short answer.', reasoning: '' },
  });
  assert.equal(estimated.requests, 1);
  assert.ok(estimated.inputTokens > 0);
  assert.ok(estimated.outputTokens > 0);
  assert.equal(estimated.exactRequests, 0);
  assert.equal(estimated.estimatedRequests, 1);
});

test('tracked completions persist exact provider and model totals and can be reset', async () => withTokenStatsHome(async () => {
  const settings = { ...DEFAULT_SETTINGS, llmTrackTokenUsage: true };
  const fetchImpl = async () => new Response(JSON.stringify({
    message: { content: 'done' }, done: true, prompt_eval_count: 11, eval_count: 4,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  await createLocalCompletion({
    provider: 'ollama', model: 'qwen-test', messages: [{ role: 'user', content: 'test' }], maxTokens: 32,
  }, { fetchImpl, settings });

  let stats = await loadLlmTokenStats();
  assert.deepEqual(stats.totals, {
    requests: 1, inputTokens: 11, outputTokens: 4, exactRequests: 1, estimatedRequests: 0,
  });
  assert.equal(stats.providers.ollama.models['qwen-test'].inputTokens, 11);
  assert.equal(stats.providers.ollama.models['qwen-test'].outputTokens, 4);

  stats = await resetLlmTokenStats({ now: new Date('2026-07-28T10:00:00.000Z') });
  assert.deepEqual(stats.totals, emptyLlmTokenStats(new Date('2026-07-28T10:00:00.000Z')).totals);
  assert.deepEqual(stats.providers, {});
}));


test('tracked retries count every provider request and mark unsupported attempts as estimated', async () => withTokenStatsHome(async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: 'schema unsupported' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
    return new Response(JSON.stringify({
      message: { content: '{"ok":true}' }, done: true, prompt_eval_count: 9, eval_count: 3,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await createLocalCompletion({
    provider: 'ollama', model: 'qwen-retry', messages: [{ role: 'user', content: 'return json' }],
    responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, maxTokens: 32,
  }, { fetchImpl, settings: { ...DEFAULT_SETTINGS, llmTrackTokenUsage: true } });
  const stats = await loadLlmTokenStats();
  assert.equal(stats.totals.requests, 2);
  assert.equal(stats.totals.exactRequests, 1);
  assert.equal(stats.totals.estimatedRequests, 1);
  assert.ok(stats.totals.inputTokens > 9);
  assert.equal(stats.totals.outputTokens, 3);
}));

test('interrupted provider output is retained as estimated token usage', async () => withTokenStatsHome(async () => {
  const fetchImpl = async () => new Response('{"message":{"content":"partial answer"}}\n', {
    status: 200, headers: { 'Content-Type': 'application/x-ndjson' },
  });
  await assert.rejects(createLocalCompletion({
    provider: 'ollama', model: 'qwen-broken', messages: [{ role: 'user', content: 'large request' }], maxTokens: 32,
  }, { fetchImpl, settings: { ...DEFAULT_SETTINGS, llmTrackTokenUsage: true } }), /before the provider reported successful completion|without a completion event|incomplete/i);
  const stats = await loadLlmTokenStats();
  assert.equal(stats.totals.requests, 1);
  assert.equal(stats.totals.exactRequests, 0);
  assert.equal(stats.totals.estimatedRequests, 1);
  assert.ok(stats.totals.inputTokens > 0);
  assert.ok(stats.totals.outputTokens > 0);
}));

test('disabled token tracking does not create request totals', async () => withTokenStatsHome(async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    message: { content: 'done' }, done: true, prompt_eval_count: 5, eval_count: 2,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  await createLocalCompletion({
    provider: 'ollama', model: 'qwen-test', messages: [{ role: 'user', content: 'test' }], maxTokens: 32,
  }, { fetchImpl, settings: { ...DEFAULT_SETTINGS, llmTrackTokenUsage: false } });
  const stats = await loadLlmTokenStats();
  assert.equal(stats.totals.requests, 0);
}));

test('Local LLM settings show token statistics only when tracking is enabled', () => {
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, llmProvider: 'ollama', llmModel: 'qwen', llmTrackTokenUsage: true });
  const state = {
    settings,
    settingsPanel: {
      subpage: null,
      models: [],
      tokenStats: {
        resetAt: '2026-07-28T10:00:00.000Z',
        totals: { requests: 2, inputTokens: 1200, outputTokens: 300, exactRequests: 2, estimatedRequests: 0 },
        providers: { ollama: { requests: 2, inputTokens: 1200, outputTokens: 300, exactRequests: 2, estimatedRequests: 0, models: {
          qwen: { requests: 2, inputTokens: 1200, outputTokens: 300, exactRequests: 2, estimatedRequests: 0 },
        } } },
      },
    },
  };
  const definition = settingsDefinitions(state).find((item) => item.id === 'localLlm');
  let parameters = settingsParameters(state, definition);
  assert.equal(parameters.at(-1).id, 'llmTokenStats');
  assert.ok(parameters.some((item) => item.id === 'llmTrackTokenUsage' && item.selected));

  state.settingsPanel.subpage = 'llmTokenStats';
  parameters = settingsParameters(state, definition);
  assert.ok(parameters.some((item) => item.id === 'llmStatsInput' && item.value === '1,200'));
  assert.ok(parameters.some((item) => item.id === 'llmStatsModel:ollama:qwen'));
  assert.ok(parameters.some((item) => item.action === 'llm-token-stats-reset'));

  state.settings.llmTrackTokenUsage = false;
  state.settingsPanel.subpage = null;
  parameters = settingsParameters(state, definition);
  assert.equal(parameters.some((item) => item.id === 'llmTokenStats'), false);
});

async function withTokenStatsHome(callback) {
  const previous = process.env.ZIPFLOW_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), 'zipflow-token-stats-test-'));
  process.env.ZIPFLOW_HOME = home;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}
