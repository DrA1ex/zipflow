import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPromptBudget, estimateTokens, fitPatchToBudget, reducePatchBudget,
} from '../src/llm/patch-budget.js';
import { generateChangeDescription } from '../src/llm/generate.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function nativeCompletion(value) {
  return jsonResponse({ output: [{ type: 'message', content: JSON.stringify(value) }], stats: {} });
}

function errorStream(message) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message } })}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function largePatch(files = 8, hunks = 12) {
  const parts = [];
  for (let file = 0; file < files; file += 1) {
    parts.push(`diff --git a/src/file-${file}.js b/src/file-${file}.js`);
    parts.push(`--- a/src/file-${file}.js`);
    parts.push(`+++ b/src/file-${file}.js`);
    for (let hunk = 0; hunk < hunks; hunk += 1) {
      parts.push(`@@ -${hunk + 1},2 +${hunk + 1},2 @@`);
      parts.push(`-${'old'.repeat(120)}`);
      parts.push(`+${'new'.repeat(120)}`);
    }
  }
  return `${parts.join('\n')}\n`;
}

test('prompt budget respects the detected context and local safety cap', () => {
  const small = createPromptBudget({ contextLength: 4_096, fixedPrompt: 'x'.repeat(300), requestedOutputTokens: 1_024 });
  const large = createPromptBudget({ contextLength: 131_072, fixedPrompt: 'x'.repeat(300), requestedOutputTokens: 1_024 });

  assert.equal(small.effectiveContextTokens, 4_096);
  assert.equal(large.effectiveContextTokens, 16_384);
  assert.ok(small.patchTokens < large.patchTokens);
  assert.ok(large.patchTokens + large.outputTokens + large.fixedPromptTokens < large.effectiveContextTokens);
});

test('small patches pass through unchanged', () => {
  const patch = 'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-old\n+new\n';
  const result = fitPatchToBudget(patch, 1_000);

  assert.equal(result.content, patch);
  assert.equal(result.truncated, false);
  assert.equal(result.omittedHunks, 0);
});

test('large patches are shortened by file and hunk while preserving a complete file manifest', () => {
  const patch = largePatch();
  const result = fitPatchToBudget(patch, 2_000);

  assert.equal(result.truncated, true);
  assert.ok(result.sentEstimatedTokens <= 2_100);
  for (let file = 0; file < 8; file += 1) assert.match(result.content, new RegExp(`# - src/file-${file}\\.js`));
  assert.match(result.content, /Zipflow omitted \d+ additional diff hunks/);
  assert.ok(result.omittedHunks > 0);
  assert.ok(estimateTokens(result.content) < estimateTokens(patch));
});

test('memory failures reduce the next patch budget more aggressively than context errors', () => {
  assert.ok(reducePatchBudget(10_000, 'out_of_memory') < reducePatchBudget(10_000, 'context_exceeded'));
});

test('generation retries an out-of-memory LM Studio stream with a smaller patch', async () => {
  const inputs = [];
  let chatCalls = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/v1/models')) return jsonResponse({
      models: [{
        type: 'llm', key: 'gemma', max_context_length: 131_072,
        loaded_instances: [{ id: 'gemma', config: { context_length: 64_000 } }],
        capabilities: { reasoning: { allowed_options: ['off', 'on'] } },
      }],
    });
    const body = JSON.parse(options.body);
    inputs.push(body.input);
    chatCalls += 1;
    if (chatCalls === 1) return errorStream('Compute error. Insufficient Memory');
    return nativeCompletion({ summary: ['Updated the project.'], commitMessage: 'Update project files' });
  };

  const result = await generateChangeDescription({
    settings: { llmProvider: 'lmstudio', llmModel: 'gemma', llmLanguage: 'English', llmApiToken: '' },
    project: { name: 'fixture', labels: ['Node.js'] },
    plan: { counts: { created: 1, updated: 4, deleted: 0 } },
    patchContent: largePatch(20, 20),
  }, { fetchImpl });

  assert.equal(result.commitMessage, 'Update project files');
  assert.equal(chatCalls, 2);
  assert.ok(inputs[1].length < inputs[0].length);
  assert.equal(result.diagnostics.attempts[0].error.code, 'out_of_memory');
});
