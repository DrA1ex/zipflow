import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createOverlayManager, renderToString, stripAnsi } from 'terlio.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { createInterruptAwareInput } from '../src/ui/interrupt-input.js';
import { DEFAULT_SETTINGS, credentialsPath, loadSettings, saveSettings, settingsBackupPath, settingsPath, updateSettings } from '../src/settings/store.js';
import { repeatLastArchive } from '../src/app/history-flow.js';
import { saveRunRecord } from '../src/runs/store.js';
import { getZipflowHome } from '../src/workflow/store.js';
import { tempDir } from '../test-support/helpers.js';
import { exists, readJson } from '../src/utils/fs.js';
import { renderZipflow } from '../src/ui/render.js';

function controllerFixture() {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'] };
  state.workflow = { policy: { label: 'Practical' }, checks: [] };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  state.overlays = createOverlayManager();
  return { state, controller };
}

test('secure credential storage preserves a token without writing it to Zipflow JSON files', async () => {
  const previous = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-settings-104-');
  try {
    await updateSettings({ ...DEFAULT_SETTINGS, llmApiToken: 'persistent-secret', archivePolicy: 'move' }, { allowClearToken: true });
    await saveSettings({ ...DEFAULT_SETTINGS, theme: 'mono', llmApiToken: '' });
    const loaded = await loadSettings();
    assert.equal(loaded.llmApiToken, 'persistent-secret');
    assert.equal(await exists(credentialsPath()), false);
    assert.equal(Object.prototype.hasOwnProperty.call(await readJson(settingsPath()), 'llmApiToken'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(await readJson(settingsBackupPath()), 'llmApiToken'), false);
  } finally {
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
  }
});

test('raw Ctrl+C input is consumed and routed before Terlio hard-coded exit handling', () => {
  const input = new EventEmitter();
  input.setEncoding = () => {};
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  input.isTTY = true;
  let interrupts = 0;
  const wrapped = createInterruptAwareInput(input, { onInterrupt: () => { interrupts += 1; } });
  let received = '';
  wrapped.on('data', (value) => { received += String(value); });
  input.emit('data', '\x03');
  assert.equal(interrupts, 1);
  assert.equal(received, '');
});

test('raw Ctrl+C cancels manual checks and exits only after the operation is idle', async () => {
  const { controller } = controllerFixture();
  const exits = [];
  controller.runtime = { exit: (code) => exits.push(code), invalidate: () => {} };
  const input = new EventEmitter();
  const wrapped = createInterruptAwareInput(input, {
    onInterrupt: () => { void controller.handleInterrupt(); },
  });
  wrapped.on('data', () => {});
  const operation = controller.beginOperation({ kind: 'manual-checks', label: 'Running manual checks' });
  input.emit('data', '\x03');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operation.signal.aborted, true);
  assert.deepEqual(exits, []);
  operation.finish();
  input.emit('data', '\x03');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [0]);
});

test('Settings categories omit navigation arrows while detail parameters use one-space arrows', () => {
  const { state } = controllerFixture();
  state.screen = 'settings';
  state.settingsPanel = {
    focus: 'categories', categoryIndex: 0, parameterIndices: {}, choiceIndices: {}, models: [],
    managedCount: 0, managedHistory: { paths: [] }, storageStats: null,
  };
  const output = stripAnsi(renderToString(renderZipflow({ state, width: 110, height: 30 }), { width: 110, height: 30 }));
  const categoryLine = output.split('\n').find((line) => /Appearance/.test(line)) ?? '';
  assert.doesNotMatch(categoryLine, /›/);
  assert.doesNotMatch(output, /  ›/);
});

test('Run history panel expands to expose more than two choices', () => {
  const { state } = controllerFixture();
  state.screen = 'run-history';
  state.menuItems = Array.from({ length: 30 }, (_, index) => ({ id: `run-${index}`, label: `Run ${index}`, description: `Description ${index}` }));
  state.menuSourceItems = state.menuItems;
  const output = stripAnsi(renderToString(renderZipflow({ state, width: 100, height: 30 }), { width: 100, height: 30 }));
  const visible = output.split('\n').filter((line) => /Run \d+/.test(line));
  assert.ok(visible.length >= 6, `expected at least 6 visible history choices, got ${visible.length}`);
});

test('Home and End navigate the active file list rather than Activity', async () => {
  const { state, controller } = controllerFixture();
  state.screen = 'export-files';
  state.menuItems = Array.from({ length: 20 }, (_, index) => ({ id: `file-${index}`, label: `file-${index}` }));
  state.selectedIndex = 8;
  state.transcriptScroll = 5;
  await controller.handleKey({ name: 'home' });
  assert.equal(state.selectedIndex, 0);
  await controller.handleKey({ name: 'end' });
  assert.equal(state.selectedIndex, 19);
  assert.equal(state.transcriptScroll, 5);
});


test('input adapter preserves non-interrupt bytes in a mixed buffer', () => {
  const input = new EventEmitter();
  input.setEncoding = () => {};
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  input.isTTY = true;
  let interrupts = 0;
  const wrapped = createInterruptAwareInput(input, { onInterrupt: () => { interrupts += 1; } });
  let received = '';
  wrapped.addListener('data', (value) => { received += String(value); });
  input.emit('data', Buffer.from('a\x03b'));
  assert.equal(interrupts, 1);
  assert.equal(received, 'ab');
});

test('input adapter reports an interrupt once with one-time and persistent data listeners', () => {
  const input = new EventEmitter();
  let interrupts = 0;
  const wrapped = createInterruptAwareInput(input, { onInterrupt: () => { interrupts += 1; } });
  let oneTimeInput = '';
  let persistentInput = '';
  wrapped.once('data', (value) => { oneTimeInput += String(value); });
  wrapped.on('data', (value) => { persistentInput += String(value); });
  input.emit('data', '\x03');
  input.emit('data', 'x');
  input.emit('data', '\x03');
  assert.equal(interrupts, 2);
  assert.equal(oneTimeInput, 'x');
  assert.equal(persistentInput, 'x');
});

test('test workers use an isolated Zipflow home unless ZIPFLOW_HOME is explicit', () => {
  const previousHome = process.env.ZIPFLOW_HOME;
  const previousContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.ZIPFLOW_HOME;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  try {
    assert.match(getZipflowHome(), new RegExp(`zipflow-test-home-${process.pid}$`));
  } finally {
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
    if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousContext;
  }
});

async function repeatArchiveFixture({ action, originalExists, movedExists }) {
  const previous = process.env.ZIPFLOW_HOME;
  const home = await tempDir('zipflow-repeat-104-home-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const files = await tempDir('zipflow-repeat-104-files-');
    const original = path.join(files, 'original.zip');
    const moved = path.join(files, 'storage', 'moved.zip');
    if (originalExists) await writeFile(original, 'original');
    if (movedExists) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(moved), { recursive: true });
      await writeFile(moved, 'moved');
    }
    const run = {
      version: 9,
      id: `repeat-${action}`,
      projectPath: files,
      projectName: 'fixture',
      workflowName: 'fixture',
      archivePath: original,
      archiveDisposition: { action, originalPath: original, path: action === 'moved' ? moved : original },
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      plan: null,
      decisions: [],
      autonomy: { mode: 'manual', paused: false, decisions: [] },
    };
    await saveRunRecord(run);
    const { state, controller } = controllerFixture();
    state.project.root = files;
    state.workflow.lastRunId = run.id;
    let inspected = null;
    controller.inspectArchivePath = async (archivePath, options) => { inspected = { archivePath, options }; };
    await repeatLastArchive(controller);
    return { inspected, original, moved };
  } finally {
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
  }
}

test('Repeat last archive prefers the moved storage path', async () => {
  const result = await repeatArchiveFixture({ action: 'moved', originalExists: false, movedExists: true });
  assert.equal(result.inspected.archivePath, result.moved);
  assert.equal(result.inspected.options.allowDuplicate, true);
});

test('Repeat last archive keeps using the original path when the source was kept', async () => {
  const result = await repeatArchiveFixture({ action: 'kept', originalExists: true, movedExists: false });
  assert.equal(result.inspected.archivePath, result.original);
});

test('workspace input interception prevents Terlio from exiting before Ctrl+C cancellation', async () => {
  const { installWorkspaceInterruptHandler } = await import('../src/ui/workspace-interrupt.js');
  const calls = [];
  const app = {
    handleInputEvent(event) { calls.push(['original', event]); },
    invalidate() { calls.push(['invalidate']); },
  };
  const controller = {
    async handleInterrupt() { calls.push(['interrupt']); },
    handleUnexpected(error) { throw error; },
  };
  const detach = installWorkspaceInterruptHandler(app, controller);
  app.handleInputEvent({ type: 'key', key: { name: 'ctrl-c', ctrl: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['interrupt'], ['invalidate']]);
  detach();
  app.handleInputEvent({ type: 'key', key: { name: 'enter' } });
  assert.equal(calls.at(-1)[0], 'original');
});

test('workspace input interception leaves pointer and non-interrupt keys to Terlio', async () => {
  const { installWorkspaceInterruptHandler } = await import('../src/ui/workspace-interrupt.js');
  const calls = [];
  const app = {
    handleInputEvent(event) { calls.push(event); },
    invalidate() {},
  };
  const controller = {
    async handleInterrupt() { throw new Error('unexpected interrupt'); },
    handleUnexpected(error) { throw error; },
  };
  installWorkspaceInterruptHandler(app, controller);
  app.handleInputEvent({ type: 'pointer', key: { name: 'ctrl-c', ctrl: true } });
  app.handleInputEvent({ type: 'key', key: { name: 'enter' } });
  assert.equal(calls.length, 2);
});
