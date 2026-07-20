import test from 'node:test';
import assert from 'node:assert/strict';
import { explainCheckFailure } from '../src/llm/failure.js';

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function modelCatalog() {
  return { models: [{
    type: 'llm', key: 'fixture', max_context_length: 16_384,
    loaded_instances: [{ id: 'fixture-loaded', config: { context_length: 16_384 } }],
    capabilities: { reasoning: { allowed_options: ['off'], default: 'off' } },
  }] };
}

function completion(content) {
  return jsonResponse({ output: [{ type: 'message', content }] });
}

const failedCheck = {
  name: 'Unit tests', commandText: 'npm test', code: 1,
  stdout: 'FAIL test/config.test.js\nExpected 2 but received 3', stderr: '',
};

test('same-context failure analysis includes the previous change review', async () => {
  let body;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/v1/models')) return jsonResponse(modelCatalog());
    body = JSON.parse(options.body);
    return completion('ERROR EXPLANATION:\nA test assertion failed.\nLIKELY CAUSE:\nThe changed configuration returns 3.\nNEXT STEPS:\n- Review the new default.');
  };
  const result = await explainCheckFailure({
    settings: {
      llmProvider: 'lmstudio', llmModel: 'fixture-loaded', llmLanguage: 'English',
      llmFailureAnalysis: 'same-context', llmApiToken: '',
    },
    project: { name: 'fixture' },
    run: { llm: { contextText: 'Summary:\n- Changed configuration defaults.' } },
    failedCheck,
  }, { fetchImpl });

  assert.equal(result.mode, 'same-context');
  assert.equal(typeof body.input, 'string');
  assert.match(body.input, /PREVIOUS MODEL CONTEXT:/);
  assert.match(body.input, /Changed configuration defaults/);
  assert.match(body.input, /CURRENT USER REQUEST:/);
  assert.match(result.text, /LIKELY CAUSE/);
});

test('new-context failure analysis sends only the failed command context', async () => {
  let body;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/v1/models')) return jsonResponse(modelCatalog());
    body = JSON.parse(options.body);
    return completion('ERROR EXPLANATION:\nThe test failed.\nLIKELY CAUSE:\nAssertion mismatch.\nNEXT STEPS:\n- Inspect the fixture.');
  };
  const result = await explainCheckFailure({
    settings: {
      llmProvider: 'lmstudio', llmModel: 'fixture-loaded', llmLanguage: 'English',
      llmFailureAnalysis: 'new-context', llmApiToken: '',
    },
    project: { name: 'fixture' },
    run: { llm: { contextText: 'Must not be sent' } },
    failedCheck,
  }, { fetchImpl });

  assert.equal(result.mode, 'new-context');
  assert.equal(typeof body.input, 'string');
  assert.doesNotMatch(body.input, /Must not be sent/);
  assert.match(body.input, /Expected 2 but received 3/);
});
