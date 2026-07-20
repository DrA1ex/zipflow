import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalLlmSession } from '../src/llm/session.js';
import { reviewArchiveStructure } from '../src/llm/archive-review.js';
import { generateChangeDescription } from '../src/llm/generate.js';
import { extractedFixture, tempDir, writeFiles } from '../test-support/helpers.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function nativeCompletion(content) {
  return jsonResponse({ output: [{ type: 'message', content }] });
}

test('one authenticated LM Studio session is reused across structure and patch analysis', async () => {
  const root = await tempDir('zipflow-llm-session-project-');
  await writeFiles(root, { 'package.json': '{}', 'src/index.js': 'old' });
  const extracted = await extractedFixture(await tempDir('zipflow-llm-session-archive-'), {
    'package.json': '{}', 'src/index.js': 'new',
  });
  const calls = [];
  let chat = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, authorization: new Headers(options.headers).get('authorization') });
    if (url.endsWith('/api/v1/models')) return jsonResponse({
      models: [{
        type: 'llm', key: 'gemma', max_context_length: 32_000,
        loaded_instances: [{ id: 'gemma-loaded', config: { context_length: 16_000 } }],
        capabilities: { reasoning: { allowed_options: ['off'] } },
      }],
    });
    chat += 1;
    if (chat === 1) return nativeCompletion(JSON.stringify({
      assessment: 'suitable', confidence: 'high', reasons: ['Project structure matches.'],
    }));
    return nativeCompletion(JSON.stringify({
      summary: ['Updated the source file.'], commitMessage: 'Update source file',
    }));
  };
  const settings = {
    llmProvider: 'lmstudio', llmModel: 'gemma', llmLanguage: 'English',
    llmApiToken: 'secret-token', llmArchiveReview: 'structure', llmChangeDelivery: 'patch',
  };
  const session = await resolveLocalLlmSession(settings, { fetchImpl });
  const plan = {
    counts: { created: 0, updated: 1, deleted: 0, unchanged: 1 },
    created: [], updated: [{ path: 'src/index.js' }], deleted: [],
  };
  await reviewArchiveStructure({
    settings, project: { root, name: 'fixture', labels: ['Node.js'], git: false },
    workflow: { exclude: ['.env', '.env.*', '.venv/**', '.DS_Store'] }, extracted, plan,
  }, { fetchImpl, session });
  await generateChangeDescription({
    settings, project: { name: 'fixture', labels: ['Node.js'] }, plan,
    patchContent: 'diff --git a/src/index.js b/src/index.js\n@@ -1 +1 @@\n-old\n+new\n',
  }, { fetchImpl, session });

  assert.equal(calls.filter((call) => call.url.endsWith('/api/v1/models')).length, 1);
  assert.deepEqual(calls.map((call) => call.authorization), calls.map(() => 'Bearer secret-token'));
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    '/api/v1/models', '/api/v1/chat', '/api/v1/chat',
  ]);
});

test('LM Studio authentication failures are not hidden behind fallback model metadata', async () => {
  const settings = { llmProvider: 'lmstudio', llmModel: 'gemma', llmApiToken: '' };
  await assert.rejects(
    () => resolveLocalLlmSession(settings, {
      fetchImpl: async () => jsonResponse({ error: {
        code: 'invalid_api_key', message: 'An LM Studio API token is required.',
      } }, 401),
    }),
    (error) => error.code === 'invalid_api_key' && /token is required/i.test(error.message),
  );
});
