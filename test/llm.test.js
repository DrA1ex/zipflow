import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCompletion, listLocalModels } from '../src/llm/client.js';
import { extractUnstructured, generateChangeDescription, parseResponse } from '../src/llm/generate.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(payloads) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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

test('optional LLM API token is sent only when configured', async () => {
  const headers = [];
  const fetchImpl = async (_url, options) => {
    headers.push(new Headers(options.headers));
    return jsonResponse({ data: [] });
  };

  await listLocalModels('lmstudio', { fetchImpl });
  await listLocalModels('lmstudio', { fetchImpl, apiToken: 'secret-token' });

  assert.equal(headers[0].has('authorization'), false);
  assert.equal(headers[1].get('authorization'), 'Bearer secret-token');
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
    settings: { llmProvider: 'ollama', llmModel: 'qwen-coder', llmLanguage: 'Russian', llmApiToken: '' },
    project: { name: 'fixture', labels: ['Node.js'] },
    plan: { counts: { created: 0, updated: 1, deleted: 0 } },
    patchContent: 'diff --git a/a.js b/a.js\n-old\n+new\n',
  }, { fetchImpl });

  assert.deepEqual(result.summary, ['Добавлена проверка конфигурации.']);
  assert.equal(result.commitMessage, 'Добавить проверку конфигурации');
  assert.match(requestBody.messages[0].content, /Write both summary and commitMessage in Russian/);
  assert.match(requestBody.messages[1].content, /PATCH START/);
  assert.equal(requestBody.response_format.type, 'json_schema');
  assert.equal(requestBody.stream, true);
});

test('completion streams reasoning and structured content incrementally', async () => {
  const events = [];
  const fetchImpl = async () => sseResponse([
    { choices: [{ delta: { reasoning_content: 'Inspecting ' }, finish_reason: null }] },
    { choices: [{ delta: { reasoning: 'the patch.\n' }, finish_reason: null }] },
    { choices: [{ delta: { content: '{"summary":["Updated files"],' }, finish_reason: null }] },
    { choices: [{ delta: { content: '"commitMessage":"Update files"}' }, finish_reason: 'stop' }] },
  ]);

  const completion = await createLocalCompletion({
    provider: 'lmstudio', model: 'fixture', messages: [], responseSchema: { type: 'object' },
  }, { fetchImpl, onEvent: (event) => events.push(event) });

  assert.equal(completion.reasoning, 'Inspecting the patch.\n');
  assert.equal(parseResponse(completion.content).commitMessage, 'Update files');
  assert.ok(events.some((event) => event.type === 'chunk' && event.reasoningDelta));
  assert.ok(events.some((event) => event.type === 'chunk' && event.contentDelta));
});

test('completion retries with JSON mode when a server rejects JSON schema', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (body.response_format.type === 'json_schema') return new Response('unsupported', { status: 400 });
    return jsonResponse({ choices: [{ message: { content: '{"summary":["ok"],"commitMessage":"Update files"}' } }] });
  };
  const completion = await createLocalCompletion({
    provider: 'lmstudio', model: 'fixture', messages: [], responseSchema: { type: 'object' },
  }, { fetchImpl });

  assert.equal(calls, 2);
  assert.equal(parseResponse(completion.content).commitMessage, 'Update files');
});

test('reasoning-only LM Studio response is repaired instead of reported as empty', async () => {
  let calls = 0;
  const progress = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({
      choices: [{
        message: {
          content: '',
          reasoning_content: [
            'Summary (Russian):',
            '1. Добавлена канонизация путей.',
            '2. Расширены тесты определения проекта.',
            'Commit Message (Russian):',
          ].join('\n'),
        },
        finish_reason: 'length',
      }],
    });
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({
      summary: ['Добавлена канонизация путей.', 'Расширены тесты определения проекта.'],
      commitMessage: 'Исправить канонизацию путей проекта',
    }) }, finish_reason: 'stop' }] });
  };

  const result = await generateChangeDescription({
    settings: { llmProvider: 'lmstudio', llmModel: 'gemma', llmLanguage: 'Russian', llmApiToken: 'token' },
    project: { name: 'zipflow', labels: ['Node.js'] },
    plan: { counts: { created: 0, updated: 5, deleted: 0 } },
    patchContent: 'diff --git a/a.js b/a.js\n-old\n+new\n',
  }, { fetchImpl, onEvent: (event) => progress.push(event) });

  assert.equal(calls, 2);
  assert.equal(result.commitMessage, 'Исправить канонизацию путей проекта');
  assert.equal(result.diagnostics.repaired, true);
  assert.ok(progress.some((event) => event.type === 'phase' && event.phase === 'repairing'));
});

test('unstructured reasoning can preserve a summary when no JSON is available', () => {
  const result = extractUnstructured([
    'Summary (Russian):',
    '1. Добавлена нормализация путей.',
    '2. Обновлена блокировка проектов.',
    'Commit Message (Russian):',
    'Subject: Исправить идентификацию проекта',
  ].join('\n'));

  assert.deepEqual(result.summary, ['Добавлена нормализация путей.', 'Обновлена блокировка проектов.']);
  assert.equal(result.commitMessage, 'Исправить идентификацию проекта');
});
