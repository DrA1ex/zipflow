import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { createLocalCompletion, listLocalModelChoices } from '../src/llm/client.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { testSelectedModel } from '../src/app/settings-model-check.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';

function fakeCodexRuntime({
  initializeDelayMs = 0,
  onSpawn = null,
  permissionProfiles = [{ id: ':read-only', allowed: true }],
  permissionProfileApi = true,
  permissionProfilePages = null,
} = {}) {
  const requests = [];
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.exitCode = null;
    const activeIntervals = new Set();
    const activeTimeouts = new Set();
    const lines = createInterface({ input: child.stdin, crlfDelay: Infinity });
    const send = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
    const stop = (signal = 'SIGTERM') => {
      if (child.exitCode !== null) return false;
      for (const interval of activeIntervals) clearInterval(interval);
      for (const timeout of activeTimeouts) clearTimeout(timeout);
      activeIntervals.clear();
      activeTimeouts.clear();
      child.killed = true;
      child.exitCode = 0;
      lines.close();
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit('exit', 0, signal));
      return true;
    };
    child.kill = stop;
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      requests.push(message);
      if (message.method === 'initialize') {
        if (!initializeDelayMs) return send({ id: message.id, result: { userAgent: 'fake-codex' } });
        const timeout = setTimeout(() => {
          activeTimeouts.delete(timeout);
          send({ id: message.id, result: { userAgent: 'fake-codex' } });
        }, initializeDelayMs);
        activeTimeouts.add(timeout);
        return undefined;
      }
      if (message.method === 'initialized') return undefined;
      if (message.method === 'permissionProfile/list') {
        if (!permissionProfileApi) return send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
        if (permissionProfilePages) {
          const pageIndex = message.params.cursor ? Number(message.params.cursor) : 0;
          const page = permissionProfilePages[pageIndex] ?? [];
          const nextCursor = pageIndex + 1 < permissionProfilePages.length ? String(pageIndex + 1) : null;
          return send({ id: message.id, result: { data: page, nextCursor } });
        }
        return send({ id: message.id, result: { data: permissionProfiles, nextCursor: null } });
      }
      if (message.method === 'model/list') return send({ id: message.id, result: { data: [{
        id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test', isDefault: true,
        defaultReasoningEffort: 'medium', supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'fast' }, { reasoningEffort: 'high', description: 'deep' },
        ], inputModalities: ['text'],
      }], nextCursor: null } });
      if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: 'thr-test' } } });
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-test', status: 'inProgress', items: [] } } });
        if (message.params.model === 'never-complete') {
          send({ method: 'item/agentMessage/delta', params: { delta: 'partial output' } });
          const interval = setInterval(() => {
            send({ method: 'item/agentMessage/delta', params: { delta: '.' } });
          }, 5);
          activeIntervals.add(interval);
          return undefined;
        }
        if (message.params.model === 'wait-cancel') {
          send({ method: 'item/agentMessage/delta', params: { delta: 'partial output' } });
          return undefined;
        }
        if (message.params.model === 'context-fail') {
          return send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'failed', error: {
            message: 'context full', codexErrorInfo: { type: 'ContextWindowExceeded' },
          } } } });
        }
        const answer = message.params.outputSchema
          ? JSON.stringify({
              schemaVersion: 1, gate: 'compatibility-decision', action: 'continue', targetId: null,
              confidence: 1, summary: 'Autonomous decision protocol works.', evidence: [], risks: [], conditions: [],
            })
          : 'ZIPFLOW_COMPATIBILITY_OK';
        send({ method: 'item/reasoning/summaryTextDelta', params: { delta: 'brief reasoning' } });
        send({ method: 'item/agentMessage/delta', params: { delta: answer.slice(0, Math.ceil(answer.length / 2)) } });
        send({ method: 'item/agentMessage/delta', params: { delta: answer.slice(Math.ceil(answer.length / 2)) } });
        send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: answer } } });
        return send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed', error: null } } });
      }
      if (message.method === 'turn/interrupt') {
        return send({ method: 'turn/completed', params: { turn: { id: message.params.turnId, status: 'interrupted', error: null } } });
      }
      return undefined;
    });
    children.push(child);
    onSpawn?.(child);
    return child;
  };
  return { requests, children, spawnImpl, executable: 'fake-codex' };
}

function runtimeOptions(runtime, overrides = {}) {
  return {
    spawnImpl: runtime.spawnImpl,
    executable: runtime.executable,
    connectionTimeoutMs: 250,
    ...overrides,
  };
}

test('Codex app-server lists models with effort capabilities and completes a text turn', async () => {
  const runtime = fakeCodexRuntime();
  const models = await listLocalModelChoices('codex', runtimeOptions(runtime));
  assert.deepEqual(models.map((item) => item.id), ['gpt-test']);
  assert.deepEqual(models[0].reasoningOptions, ['low', 'high']);
  assert.equal(models[0].reasoningDefault, 'medium');

  const events = [];
  const result = await createLocalCompletion({
    provider: 'codex', model: 'gpt-test', messages: [{ role: 'user', content: 'test' }],
    reasoningEffort: 'high', maxTokens: 64,
  }, runtimeOptions(runtime, { onEvent: (event) => events.push(event) }));

  assert.equal(result.content, 'ZIPFLOW_COMPATIBILITY_OK');
  assert.equal(result.reasoning, 'brief reasoning');
  assert.equal(result.finishReason, 'completed');
  assert.ok(events.some((event) => event.type === 'stream-open'));
  assert.ok(events.some((event) => event.type === 'complete'));

  const initialize = runtime.requests.find((item) => item.method === 'initialize');
  assert.equal(initialize.params.capabilities.experimentalApi, true);
  const profileList = runtime.requests.find((item) => item.method === 'permissionProfile/list');
  assert.equal(typeof profileList.params.cwd, 'string');
  const thread = runtime.requests.find((item) => item.method === 'thread/start');
  assert.equal(thread.params.permissions, ':read-only');
  assert.equal(Object.hasOwn(thread.params, 'sandbox'), false);
  const turn = runtime.requests.find((item) => item.method === 'turn/start');
  assert.equal(turn.params.model, 'gpt-test');
  assert.equal(turn.params.effort, 'high');
  assert.equal(turn.params.approvalPolicy, 'never');
  assert.equal(Object.hasOwn(turn.params, 'sandboxPolicy'), false);
  assert.equal(turn.params.outputSchema, undefined);
});

test('Codex app-server context failure is classified and does not become a completed response', async () => {
  const runtime = fakeCodexRuntime();
  await assert.rejects(() => createLocalCompletion({
    provider: 'codex', model: 'context-fail', messages: [{ role: 'user', content: 'large prompt' }],
  }, runtimeOptions(runtime)), (error) => {
    assert.equal(error.code, 'context_exceeded');
    assert.match(error.message, /context window/i);
    return true;
  });
});

test('Codex app-server passes the complete settings model compatibility check without requiring a commit message', async () => {
  const runtime = fakeCodexRuntime();
  const previousHome = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = await mkdtemp(path.join(os.tmpdir(), 'zipflow-codex-model-test-home-'));
  try {
    const state = createInitialState();
    state.settings = {
      ...DEFAULT_SETTINGS,
      llmProvider: 'codex',
      llmModel: 'gpt-test',
      llmReasoningEffort: 'high',
      llmUseExternalCodexServer: true,
      llmCodexEndpoint: 'stdio://',
      llmUseCommitMessage: true,
      binaryPaths: { ...DEFAULT_SETTINGS.binaryPaths, codex: runtime.executable },
    };
    state.settingsPanel = {};
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};

    const ok = await testSelectedModel(controller, {
      completionOptions: runtimeOptions(runtime, { totalDeadlineMs: 250, idleTimeoutMs: 100 }),
    });

    assert.equal(ok, true);
    assert.equal(state.settingsPanel.modelTest.status, 'passed');
    assert.equal(state.settingsPanel.modelTest.transportProtocol, true);
    assert.equal(state.settingsPanel.modelTest.autonomousDecisionProtocol, true);
    assert.equal(state.settingsPanel.modelTest.error, undefined);
    const turns = runtime.requests.filter((item) => item.method === 'turn/start');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].params.outputSchema, undefined);
    assert.equal(turns[1].params.outputSchema.type, 'object');
    assert.equal(turns.every((item) => item.params.effort === 'high'), true);
  } finally {
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
  }
});

test('Codex app-server enforces a total completion deadline even while events are arriving', async () => {
  const runtime = fakeCodexRuntime({ initializeDelayMs: 60 });
  const startedAt = performance.now();
  await assert.rejects(() => createLocalCompletion({
    provider: 'codex', model: 'never-complete', messages: [{ role: 'user', content: 'stream forever' }],
  }, runtimeOptions(runtime, { timeoutMs: 40, idleTimeoutMs: 200 })), (error) => {
    assert.equal(error.code, 'total_deadline');
    assert.match(error.message, /did not complete/i);
    return true;
  });
  assert.ok(performance.now() - startedAt < 250);
});

test('Codex app-server cancellation during RPC startup does not leave a pending promise', async () => {
  const abortController = new AbortController();
  const runtime = fakeCodexRuntime({ onSpawn: () => abortController.abort() });
  await assert.rejects(() => createLocalCompletion({
    provider: 'codex', model: 'gpt-test', messages: [{ role: 'user', content: 'cancel startup' }],
  }, runtimeOptions(runtime, { signal: abortController.signal, timeoutMs: 500, idleTimeoutMs: 250 })), (error) => {
    assert.equal(error.code, 'cancelled');
    return true;
  });
  assert.equal(runtime.children.every((child) => child.exitCode === 0), true);
});

test('Codex app-server cancellation sends threadId and turnId to turn/interrupt', async () => {
  const runtime = fakeCodexRuntime();
  const abortController = new AbortController();
  let aborted = false;
  const pending = createLocalCompletion({
    provider: 'codex', model: 'wait-cancel', messages: [{ role: 'user', content: 'wait' }],
  }, runtimeOptions(runtime, {
    signal: abortController.signal,
    timeoutMs: 500,
    idleTimeoutMs: 250,
    onEvent: (event) => {
      if (event.type === 'stream-open' && !aborted) {
        aborted = true;
        abortController.abort();
      }
    },
  }));
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'cancelled');
    return true;
  });
  const interrupt = runtime.requests.find((item) => item.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: 'thr-test', turnId: 'turn-test' });
});

test('Codex app-server refuses a managed configuration that blocks :read-only', async () => {
  const runtime = fakeCodexRuntime({ permissionProfiles: [{ id: ':read-only', allowed: false }] });
  await assert.rejects(() => createLocalCompletion({
    provider: 'codex', model: 'gpt-test', messages: [{ role: 'user', content: 'test' }],
  }, runtimeOptions(runtime)), (error) => {
    assert.equal(error.code, 'permission_profile_denied');
    assert.match(error.message, /not allowed/i);
    return true;
  });
  assert.equal(runtime.requests.some((item) => item.method === 'thread/start'), false);
});


test('Codex app-server follows permission profile pagination before selecting :read-only', async () => {
  const runtime = fakeCodexRuntime({
    permissionProfilePages: [
      [{ id: ':workspace', allowed: true }],
      [{ id: ':read-only', allowed: true }],
    ],
  });
  const result = await createLocalCompletion({
    provider: 'codex', model: 'gpt-test', messages: [{ role: 'user', content: 'test' }],
  }, runtimeOptions(runtime));
  assert.equal(result.content, 'ZIPFLOW_COMPATIBILITY_OK');
  const lists = runtime.requests.filter((item) => item.method === 'permissionProfile/list');
  assert.equal(lists.length, 2);
  assert.equal(Object.hasOwn(lists[0].params, 'cursor'), false);
  assert.equal(lists[1].params.cursor, '1');
  const thread = runtime.requests.find((item) => item.method === 'thread/start');
  assert.equal(thread.params.permissions, ':read-only');
});

test('Codex app-server fails closed when :read-only does not report allowed true', async () => {
  const runtime = fakeCodexRuntime({ permissionProfiles: [{ id: ':read-only' }] });
  await assert.rejects(() => createLocalCompletion({
    provider: 'codex', model: 'gpt-test', messages: [{ role: 'user', content: 'test' }],
  }, runtimeOptions(runtime)), (error) => {
    assert.equal(error.code, 'permission_profile_denied');
    return true;
  });
  assert.equal(runtime.requests.some((item) => item.method === 'thread/start'), false);
});

test('Codex app-server falls back to the documented legacy read-only shape only when permission profiles are unavailable', async () => {
  const runtime = fakeCodexRuntime({ permissionProfileApi: false });
  const result = await createLocalCompletion({
    provider: 'codex', model: 'gpt-test', messages: [{ role: 'user', content: 'test' }],
  }, runtimeOptions(runtime));
  assert.equal(result.content, 'ZIPFLOW_COMPATIBILITY_OK');
  const thread = runtime.requests.find((item) => item.method === 'thread/start');
  assert.equal(Object.hasOwn(thread.params, 'permissions'), false);
  const turn = runtime.requests.find((item) => item.method === 'turn/start');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(Object.hasOwn(turn.params.sandboxPolicy, 'access'), false);
});


function fakeCodexWebSocketRuntime({ connectionFailures = 0 } = {}) {
  const requests = [];
  const connections = [];
  const spawns = [];
  let attempts = 0;
  const connectImpl = async (endpoint, options = {}) => {
    attempts += 1;
    connections.push({ endpoint, token: options.token ?? '' });
    if (attempts <= connectionFailures) {
      const error = new Error('connection refused');
      error.code = 'connection_failed';
      throw error;
    }
    const socket = new EventEmitter();
    socket.closed = false;
    socket.send = (text) => {
      const message = JSON.parse(text);
      requests.push(message);
      const send = (value) => queueMicrotask(() => socket.emit('message', JSON.stringify(value)));
      if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake-shared-codex' } });
      else if (message.method === 'model/list') send({ id: message.id, result: {
        data: [{ id: 'shared-model', model: 'shared-model', displayName: 'Shared Model', isDefault: true }],
        nextCursor: null,
      } });
    };
    socket.close = () => {
      socket.closed = true;
      queueMicrotask(() => socket.emit('close'));
    };
    return socket;
  };
  const spawnImpl = (...args) => {
    const child = new EventEmitter();
    child.unrefCalled = false;
    child.unref = () => { child.unrefCalled = true; };
    spawns.push({ args, child });
    return child;
  };
  return { requests, connections, spawns, connectImpl, spawnImpl };
}

test('Codex custom endpoint connects to the user-managed server and never starts a process', async () => {
  const runtime = fakeCodexWebSocketRuntime();
  const models = await listLocalModelChoices('codex', {
    settings: { ...DEFAULT_SETTINGS, llmUseExternalCodexServer: true, llmCodexEndpoint: 'ws://127.0.0.1:4600/', llmApiToken: 'remote-token' },
    apiToken: 'remote-token',
    connectImpl: runtime.connectImpl,
    spawnImpl: () => { throw new Error('custom endpoints must not spawn'); },
  });

  assert.deepEqual(models.map((item) => item.id), ['shared-model']);
  assert.deepEqual(runtime.connections, [{ endpoint: 'ws://127.0.0.1:4600/', token: 'remote-token' }]);
  assert.equal(runtime.requests[0].method, 'initialize');
  assert.equal(runtime.spawns.length, 0);
});

test('Codex ignores a saved custom endpoint while the external-server switch is disabled', async () => {
  const runtime = fakeCodexWebSocketRuntime();
  const models = await listLocalModelChoices('codex', {
    settings: {
      ...DEFAULT_SETTINGS,
      llmUseExternalCodexServer: false,
      llmCodexEndpoint: 'ws://127.0.0.1:4600/',
    },
    connectImpl: runtime.connectImpl,
    spawnImpl: runtime.spawnImpl,
  });

  assert.deepEqual(models.map((item) => item.id), ['shared-model']);
  assert.equal(runtime.connections[0].endpoint, DEFAULT_SETTINGS.llmCodexEndpoint);
  assert.equal(runtime.spawns.length, 0);
});

test('Codex default shared endpoint reuses a compatible running server without spawning', async () => {
  const runtime = fakeCodexWebSocketRuntime();
  const models = await listLocalModelChoices('codex', {
    settings: { ...DEFAULT_SETTINGS },
    connectImpl: runtime.connectImpl,
    spawnImpl: runtime.spawnImpl,
  });

  assert.deepEqual(models.map((item) => item.id), ['shared-model']);
  assert.equal(runtime.connections[0].endpoint, DEFAULT_SETTINGS.llmCodexEndpoint);
  assert.equal(runtime.spawns.length, 0);
});

test('Codex default shared endpoint starts one detached server only after the probe fails', async () => {
  const runtime = fakeCodexWebSocketRuntime({ connectionFailures: 1 });
  const models = await listLocalModelChoices('codex', {
    settings: { ...DEFAULT_SETTINGS, binaryPaths: { codex: '/usr/local/bin/codex' } },
    executable: '/usr/local/bin/codex',
    connectImpl: runtime.connectImpl,
    spawnImpl: runtime.spawnImpl,
    sleepImpl: async () => {},
  });

  assert.deepEqual(models.map((item) => item.id), ['shared-model']);
  assert.equal(runtime.connections.length, 2);
  assert.equal(runtime.spawns.length, 1);
  assert.deepEqual(runtime.spawns[0].args.slice(0, 2), [
    '/usr/local/bin/codex',
    ['app-server', '--listen', DEFAULT_SETTINGS.llmCodexEndpoint],
  ]);
  assert.equal(runtime.spawns[0].args[2].detached, true);
  assert.equal(runtime.spawns[0].args[2].stdio, 'ignore');
  assert.equal(runtime.spawns[0].child.unrefCalled, true);
});


test('parallel Codex callers share one managed launch when the default server is initially unavailable', async () => {
  const runtime = fakeCodexWebSocketRuntime({ connectionFailures: 2 });
  const options = {
    settings: { ...DEFAULT_SETTINGS, binaryPaths: { codex: '/usr/local/bin/codex' } },
    executable: '/usr/local/bin/codex',
    connectImpl: runtime.connectImpl,
    spawnImpl: runtime.spawnImpl,
    sleepImpl: async () => {},
  };

  const [first, second] = await Promise.all([
    listLocalModelChoices('codex', options),
    listLocalModelChoices('codex', options),
  ]);

  assert.deepEqual(first.map((item) => item.id), ['shared-model']);
  assert.deepEqual(second.map((item) => item.id), ['shared-model']);
  assert.equal(runtime.spawns.length, 1);
});

test('Codex unavailable custom endpoint fails without falling back to a local process', async () => {
  const runtime = fakeCodexWebSocketRuntime({ connectionFailures: 1 });
  await assert.rejects(() => listLocalModelChoices('codex', {
    settings: { ...DEFAULT_SETTINGS, llmUseExternalCodexServer: true, llmCodexEndpoint: 'ws://127.0.0.1:4700/' },
    connectImpl: runtime.connectImpl,
    spawnImpl: runtime.spawnImpl,
  }), (error) => {
    assert.equal(error.code, 'connection_failed');
    assert.match(error.message, /user-managed.*never starts custom endpoints/i);
    return true;
  });
  assert.equal(runtime.spawns.length, 0);
});
