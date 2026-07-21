import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCompletion, listLocalModels } from '../src/llm/client.js';
import { extractUnstructured, generateChangeDescription, parseResponse } from '../src/llm/generate.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const entry of events) {
        const event = entry.event ? `event: ${entry.event}\n` : '';
        controller.enqueue(encoder.encode(`${event}data: ${JSON.stringify(entry.data)}\n\n`));
      }
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function lmModels(contextLength = 32_000) {
  return {
    models: [
      {
        type: 'llm', key: 'gemma', max_context_length: 131_072,
        loaded_instances: [{ id: 'gemma-loaded', config: { context_length: contextLength } }],
        capabilities: { reasoning: { allowed_options: ['off', 'on'], default: 'on' } },
      },
      { type: 'embedding', key: 'embed', loaded_instances: [] },
    ],
  };
}

function nativeCompletion(content, reasoning = '') {
  return jsonResponse({
    output: [
      ...(reasoning ? [{ type: 'reasoning', content: reasoning }] : []),
      ...(content ? [{ type: 'message', content }] : []),
    ],
    stats: { input_tokens: 100, total_output_tokens: 20 },
  });
}

test('LM Studio uses its native model catalog and excludes embedding models', async () => {
  let requested;
  const fetchImpl = async (url) => {
    requested = url;
    return jsonResponse(lmModels());
  };

  assert.deepEqual(await listLocalModels('lmstudio', { fetchImpl }), ['gemma']);
  assert.equal(requested, 'http://127.0.0.1:1234/api/v1/models');
});

test('Ollama keeps the OpenAI-compatible model list', async () => {
  let requested;
  const fetchImpl = async (url) => {
    requested = url;
    return jsonResponse({ data: [{ id: 'qwen-coder' }, { id: 'llama' }] });
  };

  assert.deepEqual(await listLocalModels('ollama', { fetchImpl }), ['llama', 'qwen-coder']);
  assert.equal(requested, 'http://127.0.0.1:11434/v1/models');
});

test('optional LLM API token is sent to native model discovery', async () => {
  const received = [];
  const fetchImpl = async (_url, options) => {
    received.push(new Headers(options.headers));
    return jsonResponse(lmModels());
  };

  await listLocalModels('lmstudio', { fetchImpl });
  await listLocalModels('lmstudio', { fetchImpl, apiToken: 'secret-token' });

  assert.equal(received[0].has('authorization'), false);
  assert.equal(received[1].get('authorization'), 'Bearer secret-token');
});

test('LM Studio generation uses native streaming settings and a safe context length', async () => {
  let chatBody;
  let chatUrl;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/v1/models')) return jsonResponse(lmModels(32_000));
    chatUrl = url;
    chatBody = JSON.parse(options.body);
    return nativeCompletion(JSON.stringify({
      summary: ['Добавлена проверка конфигурации.'],
      commitMessage: 'Add configuration validation',
    }));
  };

  const result = await generateChangeDescription({
    settings: { llmProvider: 'lmstudio', llmModel: 'gemma-loaded', llmPromptLanguage: 'Russian',
      llmSummaryLanguage: 'Russian',
      llmCommitLanguage: 'English', llmApiToken: '' },
    project: { name: 'fixture', labels: ['Node.js'] },
    plan: { counts: { created: 0, updated: 1, deleted: 0 } },
    patchContent: 'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-old\n+new\n',
  }, { fetchImpl });

  assert.equal(chatUrl, 'http://127.0.0.1:1234/api/v1/chat');
  assert.deepEqual(result.summary, ['Добавлена проверка конфигурации.']);
  assert.equal(result.commitMessage, 'Add configuration validation');
  assert.match(chatBody.system_prompt, /Интерпретируй и выполняй следующие инструкции/);
  assert.match(chatBody.system_prompt, /Write summary and reasons in Russian[\s\S]*Write commitMessage in English/);
  assert.match(chatBody.input, /Project: fixture/);
  assert.equal(chatBody.stream, true);
  assert.equal(chatBody.reasoning, 'off');
  assert.equal(chatBody.model, 'gemma-loaded');
  assert.equal(chatBody.context_length, undefined, 'reusing a loaded instance must not request a second context allocation');
});

test('LM Studio native stream exposes model loading, prompt progress, reasoning, and answer chunks', async () => {
  const events = [];
  const fetchImpl = async () => sseResponse([
    { event: 'model_load.start', data: { type: 'model_load.start' } },
    { event: 'model_load.progress', data: { type: 'model_load.progress', progress: 0.5 } },
    { event: 'prompt_processing.progress', data: { type: 'prompt_processing.progress', progress: 0.75 } },
    { event: 'reasoning.delta', data: { type: 'reasoning.delta', content: 'Inspecting the patch.\n' } },
    { event: 'message.delta', data: { type: 'message.delta', content: '{"summary":["Updated files"],' } },
    { event: 'message.delta', data: { type: 'message.delta', content: '"commitMessage":"Update files"}' } },
    { event: 'chat.end', data: { type: 'chat.end', result: { output: [], stats: { input_tokens: 100 } } } },
  ]);

  const completion = await createLocalCompletion({
    provider: 'lmstudio', model: 'fixture', messages: [], responseSchema: { type: 'object' },
    contextLength: 8_192, reasoningOffSupported: false,
  }, { fetchImpl, onEvent: (event) => events.push(event) });

  assert.equal(completion.reasoning, 'Inspecting the patch.\n');
  assert.equal(parseResponse(completion.content).commitMessage, 'Update files');
  assert.ok(events.some((event) => event.type === 'model-load-progress' && event.progress === 0.5));
  assert.ok(events.some((event) => event.type === 'prompt-progress' && event.progress === 0.75));
  assert.ok(events.some((event) => event.type === 'chunk' && event.reasoningDelta));
  assert.ok(events.some((event) => event.type === 'chunk' && event.contentDelta));
});

test('Ollama completion retries with JSON mode when JSON schema is rejected', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (body.response_format.type === 'json_schema') return new Response('unsupported', { status: 400 });
    return jsonResponse({ choices: [{ message: { content: '{"summary":["ok"],"commitMessage":"Update files"}' } }] });
  };
  const completion = await createLocalCompletion({
    provider: 'ollama', model: 'fixture', messages: [], responseSchema: { type: 'object' },
  }, { fetchImpl });

  assert.equal(calls, 2);
  assert.equal(parseResponse(completion.content).commitMessage, 'Update files');
});

test('reasoning-only LM Studio response is repaired instead of reported as empty', async () => {
  let chatCalls = 0;
  const progress = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/v1/models')) return jsonResponse(lmModels());
    chatCalls += 1;
    if (chatCalls === 1) return nativeCompletion('', [
      'Summary (Russian):',
      '1. Добавлена канонизация путей.',
      '2. Расширены тесты определения проекта.',
      'Commit Message (Russian):',
    ].join('\n'));
    return nativeCompletion(JSON.stringify({
      summary: ['Добавлена канонизация путей.', 'Расширены тесты определения проекта.'],
      commitMessage: 'Исправить канонизацию путей проекта',
    }));
  };

  const result = await generateChangeDescription({
    settings: { llmProvider: 'lmstudio', llmModel: 'gemma-loaded', llmPromptLanguage: 'English',
      llmSummaryLanguage: 'Russian',
      llmCommitLanguage: 'Russian', llmApiToken: 'token' },
    project: { name: 'zipflow', labels: ['Node.js'] },
    plan: { counts: { created: 0, updated: 5, deleted: 0 } },
    patchContent: 'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-old\n+new\n',
  }, { fetchImpl, onEvent: (event) => progress.push(event) });

  assert.equal(chatCalls, 2);
  assert.equal(result.commitMessage, 'Исправить канонизацию путей проекта');
  assert.equal(result.diagnostics.repaired, true);
  assert.ok(progress.some((event) => event.type === 'phase' && event.phase === 'repairing'));
});

test('mid-stream context errors are classified instead of becoming No usable output', async () => {
  const fetchImpl = async () => sseResponse([
    {
      event: 'error',
      data: {
        type: 'error',
        error: { type: 'invalid_request', message: 'request (40761 tokens) exceeds the available context size (32000 tokens)' },
      },
    },
  ]);

  await assert.rejects(() => createLocalCompletion({
    provider: 'lmstudio', model: 'fixture', messages: [], responseSchema: { type: 'object' },
  }, { fetchImpl }), (error) => {
    assert.equal(error.code, 'context_exceeded');
    assert.equal(error.retryableWithSmallerPrompt, true);
    assert.match(error.message, /context window/);
    assert.doesNotMatch(error.message, /No usable output/i);
    return true;
  });
});

test('compute errors are reported as local model memory failures', async () => {
  const fetchImpl = async () => sseResponse([
    { event: 'error', data: { type: 'error', error: { type: 'internal_error', message: 'Compute error. Insufficient Memory' } } },
  ]);

  await assert.rejects(() => createLocalCompletion({
    provider: 'lmstudio', model: 'fixture', messages: [], responseSchema: { type: 'object' },
  }, { fetchImpl }), (error) => {
    assert.equal(error.code, 'out_of_memory');
    assert.equal(error.retryableWithSmallerPrompt, true);
    assert.match(error.message, /ran out of memory/);
    return true;
  });
});

test('structured response accepts common snake_case aliases', () => {
  const result = parseResponse('{"summary":"Changed files","commit_message":"Update files"}');
  assert.deepEqual(result.summary, ['Changed files']);
  assert.equal(result.commitMessage, 'Update files');
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

test('LM Studio reuses a loaded instance when the saved model is the catalog key', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/api/v1/models')) return jsonResponse(lmModels(24_000));
    return nativeCompletion('{"summary":["Updated files"],"commitMessage":"Update files"}');
  };

  const result = await generateChangeDescription({
    settings: { llmProvider: 'lmstudio', llmModel: 'gemma', llmLanguage: 'English', llmApiToken: '' },
    project: { name: 'fixture', labels: ['Node.js'] },
    plan: { counts: { created: 0, updated: 1, deleted: 0 } },
    patchContent: 'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-old\n+new\n',
  }, { fetchImpl });

  const chat = requests.find((item) => item.url.endsWith('/api/v1/chat'));
  assert.ok(chat);
  assert.equal(chat.body.model, 'gemma-loaded');
  assert.equal(chat.body.context_length, undefined);
  assert.equal(result.diagnostics.profile.loadedModel, true);
});

test('Escape cancellation aborts a local LLM stream with a dedicated error', async () => {
  const abortController = new AbortController();
  const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const pending = createLocalCompletion({
    provider: 'lmstudio', model: 'fixture', messages: [], responseSchema: { type: 'object' },
  }, { fetchImpl, signal: abortController.signal });
  abortController.abort();

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'cancelled');
    assert.match(error.message, /cancelled/i);
    return true;
  });
});


test('LM Studio chat reuses the saved numbered loaded instance ID', async () => {
  let chatBody;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/v1/models')) return jsonResponse({
      models: [{
        type: 'llm', key: 'gemma-4-e4b-it-mlx', max_context_length: 131_072,
        loaded_instances: [{ id: 'gemma-4-e4b-it-mlx:2', config: { context_length: 32_768 } }],
      }],
    });
    chatBody = JSON.parse(options.body);
    return nativeCompletion('{"summary":["Updated files"],"commitMessage":"Update files"}');
  };

  await generateChangeDescription({
    settings: {
      llmProvider: 'lmstudio', llmModel: 'gemma-4-e4b-it-mlx:2', llmLanguage: 'English', llmApiToken: '',
    },
    project: { name: 'fixture', labels: ['Node.js'] },
    plan: { counts: { created: 0, updated: 1, deleted: 0 } },
    patchContent: 'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-old\n+new\n',
  }, { fetchImpl });

  assert.equal(chatBody.model, 'gemma-4-e4b-it-mlx:2');
  assert.equal(chatBody.context_length, undefined);
});
