import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createLocalCompletion, listLocalModelChoices } from '../src/llm/client.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { testSelectedModel } from '../src/app/settings-model-check.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';
import { tempDir } from '../test-support/helpers.js';

async function fakeCodexExecutable() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-fake-codex-'));
  const executable = path.join(root, 'codex');
  const log = path.join(root, 'requests.jsonl');
  await writeFile(executable, `#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
const fs = require('node:fs');
const log = process.env.FAKE_CODEX_LOG;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', (line) => {
  if (log) fs.appendFileSync(log, line + '\\n');
  const message = JSON.parse(line);
  if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'fake-codex' } });
  if (message.method === 'initialized') return;
  if (message.method === 'model/list') return send({ id: message.id, result: { data: [{
    id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test', isDefault: true,
    defaultReasoningEffort: 'medium', supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'fast' }, { reasoningEffort: 'high', description: 'deep' },
    ], inputModalities: ['text'],
  }], nextCursor: null } });
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: 'thr-test' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-test', status: 'inProgress', items: [] } } });
    if (message.params.model === 'never-complete' || message.params.model === 'wait-cancel') {
      return send({ method: 'item/agentMessage/delta', params: { delta: 'partial output' } });
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
});
process.on('SIGTERM', () => process.exit(0));
`);
  await chmod(executable, 0o755);
  return { root, executable, log };
}

test('Codex app-server lists models with effort capabilities and completes a text turn', async () => {
  const fixture = await fakeCodexExecutable();
  const previousLog = process.env.FAKE_CODEX_LOG;
  process.env.FAKE_CODEX_LOG = fixture.log;
  try {
    const models = await listLocalModelChoices('codex', { executable: fixture.executable });
    assert.deepEqual(models.map((item) => item.id), ['gpt-test']);
    assert.deepEqual(models[0].reasoningOptions, ['low', 'high']);
    assert.equal(models[0].reasoningDefault, 'medium');

    const events = [];
    const result = await createLocalCompletion({
      provider: 'codex', model: 'gpt-test', messages: [{ role: 'user', content: 'test' }],
      reasoningEffort: 'high', maxTokens: 64,
    }, { executable: fixture.executable, onEvent: (event) => events.push(event) });

    assert.equal(result.content, 'ZIPFLOW_COMPATIBILITY_OK');
    assert.equal(result.reasoning, 'brief reasoning');
    assert.equal(result.finishReason, 'completed');
    assert.ok(events.some((event) => event.type === 'stream-open'));
    assert.ok(events.some((event) => event.type === 'complete'));

    const requests = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse);
    const turn = requests.find((item) => item.method === 'turn/start');
    assert.equal(turn.params.model, 'gpt-test');
    assert.equal(turn.params.effort, 'high');
    assert.equal(turn.params.approvalPolicy, 'never');
    assert.equal(turn.params.sandboxPolicy.type, 'readOnly');
    assert.equal(turn.params.outputSchema, undefined);
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = previousLog;
  }
});

test('Codex app-server context failure is classified and does not become a completed response', async () => {
  const fixture = await fakeCodexExecutable();
  await assert.rejects(() => createLocalCompletion({
    provider: 'codex', model: 'context-fail', messages: [{ role: 'user', content: 'large prompt' }],
  }, { executable: fixture.executable }), (error) => {
    assert.equal(error.code, 'context_exceeded');
    assert.match(error.message, /context window/i);
    return true;
  });
});


test('Codex app-server passes the complete settings model compatibility check without requiring a commit message', async () => {
  const fixture = await fakeCodexExecutable();
  const previousLog = process.env.FAKE_CODEX_LOG;
  const previousHome = process.env.ZIPFLOW_HOME;
  process.env.FAKE_CODEX_LOG = fixture.log;
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-codex-model-test-home-');
  try {
    const state = createInitialState();
    state.settings = {
      ...DEFAULT_SETTINGS,
      llmProvider: 'codex',
      llmModel: 'gpt-test',
      llmReasoningEffort: 'high',
      llmUseCommitMessage: true,
      binaryPaths: { ...DEFAULT_SETTINGS.binaryPaths, codex: fixture.executable },
    };
    state.settingsPanel = {};
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};

    const ok = await testSelectedModel(controller);

    assert.equal(ok, true);
    assert.equal(state.settingsPanel.modelTest.status, 'passed');
    assert.equal(state.settingsPanel.modelTest.transportProtocol, true);
    assert.equal(state.settingsPanel.modelTest.autonomousDecisionProtocol, true);
    assert.equal(state.settingsPanel.modelTest.error, undefined);
    const requests = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse);
    const turns = requests.filter((item) => item.method === 'turn/start');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].params.outputSchema, undefined);
    assert.equal(turns[1].params.outputSchema.type, 'object');
    assert.equal(turns.every((item) => item.params.effort === 'high'), true);
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = previousLog;
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
  }
});


test('Codex app-server enforces a total completion deadline even while events are arriving', async () => {
  const fixture = await fakeCodexExecutable();
  await assert.rejects(() => createLocalCompletion({
    provider: 'codex', model: 'never-complete', messages: [{ role: 'user', content: 'stream forever' }],
  }, { executable: fixture.executable, timeoutMs: 150, idleTimeoutMs: 1_000 }), (error) => {
    assert.equal(error.code, 'total_deadline');
    assert.match(error.message, /did not complete/i);
    return true;
  });
});

test('Codex app-server cancellation sends threadId and turnId to turn/interrupt', async () => {
  const fixture = await fakeCodexExecutable();
  const previousLog = process.env.FAKE_CODEX_LOG;
  process.env.FAKE_CODEX_LOG = fixture.log;
  try {
    const abortController = new AbortController();
    const pending = createLocalCompletion({
      provider: 'codex', model: 'wait-cancel', messages: [{ role: 'user', content: 'wait' }],
    }, { executable: fixture.executable, signal: abortController.signal, timeoutMs: 2_000, idleTimeoutMs: 1_000 });
    setTimeout(() => abortController.abort(), 80);
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'cancelled');
      return true;
    });
    const requests = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse);
    const interrupt = requests.find((item) => item.method === 'turn/interrupt');
    assert.deepEqual(interrupt.params, { threadId: 'thr-test', turnId: 'turn-test' });
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = previousLog;
  }
});
