import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChangeList, createPatchBatches, resolveDeliveryMode,
} from '../src/llm/delivery.js';
import { generateChangeDescription } from '../src/llm/generate.js';

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function modelCatalog(contextLength = 8_192) {
  return { models: [{
    type: 'llm', key: 'fixture', max_context_length: contextLength,
    loaded_instances: [{ id: 'fixture-loaded', config: { context_length: contextLength } }],
    capabilities: { reasoning: { allowed_options: ['off'], default: 'off' } },
  }] };
}

function completion(content) {
  return jsonResponse({ output: [{ type: 'message', content }], stats: { input_tokens: 100 } });
}

const plan = {
  counts: { created: 1, updated: 1, deleted: 1 },
  created: [{ path: 'src/new.js' }],
  updated: [{ path: 'src/index.js' }],
  deleted: [{ path: 'src/old.js' }],
};

test('adaptive delivery uses a patch when it fits and chunks when it does not', () => {
  assert.equal(resolveDeliveryMode('adaptive', { patchEstimatedTokens: 1_000, patchBudgetTokens: 4_000 }), 'patch');
  assert.equal(resolveDeliveryMode('adaptive', { patchEstimatedTokens: 5_000, patchBudgetTokens: 4_000 }), 'chunked');
  assert.equal(resolveDeliveryMode('change-list', { patchEstimatedTokens: 1, patchBudgetTokens: 1 }), 'change-list');
});

test('changed-path delivery contains explicit create, update, and delete actions', () => {
  const value = createChangeList(plan);
  assert.match(value, /CREATE src\/new\.js/);
  assert.match(value, /UPDATE src\/index\.js/);
  assert.match(value, /DELETE src\/old\.js/);
});

test('file patch batching keeps complete file sections in small contexts', () => {
  const patch = [
    'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n' + '+a\n'.repeat(1_500),
    'diff --git a/src/b.js b/src/b.js\n--- a/src/b.js\n+++ b/src/b.js\n' + '+b\n'.repeat(1_500),
  ].join('\n');
  const batches = createPatchBatches(patch, { maxEstimatedTokens: 900, maxFiles: 1 });
  assert.ok(batches.length >= 2);
  assert.ok(batches.every((batch) => batch.files.length === 1));
  assert.ok(batches.some((batch) => batch.files.includes('src/a.js')));
  assert.ok(batches.some((batch) => batch.files.includes('src/b.js')));
});

test('change-list mode sends no patch contents and parses a readable streamed response', async () => {
  let chatBody;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/v1/models')) return jsonResponse(modelCatalog());
    chatBody = JSON.parse(options.body);
    return completion('SUMMARY:\n- Updated project paths.\nCOMMIT MESSAGE:\nUpdate project paths');
  };
  const result = await generateChangeDescription({
    settings: {
      llmProvider: 'lmstudio', llmModel: 'fixture-loaded', llmLanguage: 'English',
      llmChangeDelivery: 'change-list', llmArchiveReview: 'disabled', llmApiToken: '',
    },
    project: { name: 'fixture', labels: ['Node.js'] }, plan,
    patchContent: 'SECRET PATCH CONTENT',
  }, { fetchImpl });

  assert.equal(result.diagnostics.delivery.resolved, 'change-list');
  assert.doesNotMatch(chatBody.input, /SECRET PATCH CONTENT/);
  assert.match(chatBody.input, /DELETE src\/old\.js/);
  assert.equal(result.commitMessage, 'Update project paths');
});

test('chunked mode analyzes file batches and synthesizes one final response', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/v1/models')) return jsonResponse(modelCatalog(12_000));
    const body = JSON.parse(options.body);
    calls.push(body.input);
    if (String(body.input).startsWith('BATCH ')) return completion('- Noted changes in this batch.');
    return completion('SUMMARY:\n- Updated two source files.\nCOMMIT MESSAGE:\nUpdate source files');
  };
  const patch = [
    'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n' + '+a\n'.repeat(4_000),
    'diff --git a/src/b.js b/src/b.js\n--- a/src/b.js\n+++ b/src/b.js\n' + '+b\n'.repeat(4_000),
  ].join('\n');
  const result = await generateChangeDescription({
    settings: {
      llmProvider: 'lmstudio', llmModel: 'fixture-loaded', llmLanguage: 'English',
      llmChangeDelivery: 'chunked', llmArchiveReview: 'disabled', llmApiToken: '',
    },
    project: { name: 'fixture', labels: ['Node.js'] }, plan,
    patchContent: patch,
  }, { fetchImpl });

  assert.equal(result.diagnostics.delivery.resolved, 'chunked');
  assert.ok(result.diagnostics.delivery.batches >= 2);
  assert.ok(calls.filter((value) => String(value).includes('BATCH ')).length >= 2);
  assert.match(calls.at(-1), /FILE-BATCH ANALYSIS NOTES/);
  assert.equal(result.commitMessage, 'Update source files');
});
