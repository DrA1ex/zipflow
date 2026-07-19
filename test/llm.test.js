import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCompletion, listLocalModels } from '../src/llm/client.js';
import { generateChangeDescription, parseResponse } from '../src/llm/generate.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

test('Ollama and LM Studio use the same OpenAI-compatible model protocol', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return jsonResponse({ data: [{ id: 'qwen-coder' }, { id: 'llama' }] });
  };

  assert.deepEqual(await listLocalModels('ollama', { fetchImpl }), ['llama', 'qwen-coder']);
  assert.deepEqual(await listLocalModels('lmstudio', { fetchImpl }), ['llama', 'qwen-coder']);
  assert.equal(requested[0], 'http://127.0.0.1:11434/v1/models');
  assert.equal(requested[1], 'http://127.0.0.1:1234/v1/models');
});

test('local LLM generation sends an English structured prompt and parses the requested response language', async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        summary: ['Добавлена проверка конфигурации.'],
        commitMessage: 'Добавить проверку конфигурации',
      }) } }],
    });
  };

  const result = await generateChangeDescription({
    settings: { llmProvider: 'ollama', llmModel: 'qwen-coder', llmLanguage: 'Russian' },
    project: { name: 'fixture', labels: ['Node.js'] },
    plan: { counts: { created: 0, updated: 1, deleted: 0 } },
    patchContent: 'diff --git a/a.js b/a.js\n-old\n+new\n',
  }, { fetchImpl });

  assert.deepEqual(result.summary, ['Добавлена проверка конфигурации.']);
  assert.equal(result.commitMessage, 'Добавить проверку конфигурации');
  assert.match(requestBody.messages[0].content, /Write both summary and commitMessage in Russian/);
  assert.match(requestBody.messages[1].content, /PATCH START/);
  assert.equal(requestBody.response_format.type, 'json_schema');
});

test('completion retries with JSON mode when a server rejects JSON schema', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (body.response_format.type === 'json_schema') return new Response('unsupported', { status: 400 });
    return jsonResponse({ choices: [{ message: { content: '{"summary":["ok"],"commitMessage":"Update files"}' } }] });
  };
  const content = await createLocalCompletion({
    provider: 'lmstudio', model: 'fixture', messages: [],
    responseSchema: { type: 'object' },
  }, { fetchImpl });

  assert.equal(calls, 2);
  assert.equal(parseResponse(content).commitMessage, 'Update files');
});
