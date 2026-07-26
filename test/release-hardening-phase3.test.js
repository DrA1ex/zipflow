import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { createInitialState, setScreen, transitionScreen } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { refreshPathSuggestions } from '../src/app/path-suggestions.js';
import { installAvailableUpdate, updateActions } from '../src/app/update-flow.js';

function createController(options = {}) {
  const state = createInitialState();
  const controller = new ZipflowController(state, options);
  controller.attachRuntime({ invalidate() {}, exit(code) { state.exitCode = code; }, overlays: null });
  return controller;
}

test('active operation is the only busy source and disables existing menu actions', () => {
  const controller = createController();
  setScreen(controller.state, 'home', { items: [{ id: 'apply', label: 'Apply update' }] });
  const operation = controller.beginOperation({ kind: 'checks', label: 'Running checks' });

  assert.equal(controller.state.busy, true);
  assert.equal(controller.state.operationState, 'running');
  assert.equal(controller.state.operationCapabilities.canApply, false);
  assert.equal(controller.state.menuItems[0].disabled, true);
  assert.throws(() => { controller.state.busy = false; }, TypeError);
  assert.throws(() => { controller.state.operationState = 'idle'; }, TypeError);

  operation.finish();
  assert.equal(controller.state.busy, false);
  assert.equal(controller.state.operationState, 'idle');
  assert.equal(controller.state.menuItems[0].disabled, undefined);
});

test('rapid duplicate transition keys cannot activate the next screen', async () => {
  const controller = createController();
  setScreen(controller.state, 'home', { items: [{ id: 'go', label: 'Continue' }] });
  let release;
  let markStarted;
  const blocker = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  let calls = 0;
  controller.activateSelected = async () => {
    calls += 1;
    markStarted();
    await blocker;
    transitionScreen(controller.state, 'next-screen');
  };

  const first = controller.handleKey({ name: 'enter' });
  const second = controller.handleKey({ name: 'enter' });
  await started;
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(controller.state.screen, 'next-screen');
});



test('new path-editor input cancels an in-flight completion before it reaches the queue', async () => {
  const controller = createController();
  controller.showEditor('project-path-input', { label: 'Project path' }, '/tmp');
  const completion = new AbortController();
  controller.state.pathSuggestionAbortController = completion;

  await controller.handleKey({ name: 'x', text: 'x', printable: true });

  assert.equal(completion.signal.aborted, true);
  assert.equal(controller.state.editor.value.endsWith('x'), true);
});

test('path completion cannot update an editor after screen navigation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-path-generation-'));
  await mkdir(path.join(root, 'child'));
  const controller = createController();
  controller.state.project = { root };
  controller.showEditor('project-path-input', { label: 'Project path' }, root);
  controller.state.pathSuggestionActive = true;

  const pending = refreshPathSuggestions(controller);
  transitionScreen(controller.state, 'home');
  await pending;

  assert.equal(controller.state.pathSuggestions, null);
  assert.equal(controller.state.pathSuggestionAbortController, null);
});

test('fatal cleanup persists recovery and stops children before releasing project ownership', async () => {
  const events = [];
  const controller = createController({
    fatalWaitMs: 500,
    persistFatalRecovery: async (_controller, _error, details) => {
      events.push(`recovery:${details.safeBoundaryReached}`);
    },
    stopProcesses: async () => { events.push('stop-processes'); },
  });
  controller.activeLock = {
    path: '/tmp/project.lock',
    release: async () => { events.push('release-lock'); },
  };
  const operation = controller.beginOperation({ kind: 'apply', label: 'Applying files', critical: true });
  const fatal = controller.handleUnexpected(new Error('render failed'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, []);

  operation.leaveCritical('safe boundary');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ['recovery:true', 'stop-processes']);
  operation.finish('cancelled');
  await fatal;

  assert.deepEqual(events, ['recovery:true', 'stop-processes', 'release-lock']);
  assert.equal(controller.activeLock, null);
  assert.equal(controller.state.screen, 'error');
  assert.equal(controller.state.menuItems.find((item) => item.id === 'exit')?.disabled, undefined);
});

test('fatal screen keeps exit available while unresolved ownership blocks other recovery actions', async () => {
  const controller = createController({
    fatalWaitMs: 5,
    persistFatalRecovery: async () => {},
    stopProcesses: async () => {},
  });
  const operation = controller.beginOperation({ kind: 'apply', label: 'Applying files' });

  await controller.handleUnexpected(new Error('operation did not stop'));

  assert.equal(controller.state.screen, 'error');
  assert.deepEqual(controller.state.menuItems.map((item) => [item.id, Boolean(item.disabled)]), [
    ['copy-diagnostics', false],
    ['exit', false],
  ]);
  operation.finish('cancelled');
});



test('self-update cancellation bypasses the occupied UI action queue', async () => {
  let releaseInstall;
  const installPending = new Promise((resolve) => { releaseInstall = resolve; });
  const controller = createController({
    updateService: {
      install: async () => installPending,
      verify: async () => ({ status: 'unchanged' }),
    },
  });
  controller.state.updatePrompt = {
    phase: 'available', currentVersion: '1.3.3', latestVersion: '1.3.4', selectedIndex: 0,
    installSupported: true, installCommand: 'npm install -g zipflow@1.3.4', installation: { installedPath: '/tmp/zipflow' },
  };

  const start = controller.handleKey({ name: 'enter' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.updatePrompt.phase, 'installing');
  const cancel = controller.handleKey({ name: 'escape' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.operations.current?.cancelRequested, true);
  releaseInstall();
  await Promise.all([start, cancel]);
  assert.equal(controller.state.updatePrompt.phase, 'available');
  assert.equal(controller.state.updatePrompt.message, 'Update cancelled.');
});

test('uncertain self-update state blocks normal continuation and offers exit only', async () => {
  const controller = createController({
    updateService: {
      install: async () => { throw new Error('npm process stopped'); },
      verify: async () => ({ status: 'uncertain', detail: 'package metadata and executable disagree' }),
    },
  });
  controller.state.updatePrompt = {
    phase: 'available', currentVersion: '1.3.3', latestVersion: '1.3.4', selectedIndex: 0,
    installSupported: true, installCommand: 'npm install -g zipflow@1.3.4', installation: { installedPath: '/tmp/zipflow' },
  };

  await installAvailableUpdate(controller);

  assert.equal(controller.state.updatePrompt.phase, 'uncertain');
  assert.deepEqual(updateActions(controller.state.updatePrompt).map((item) => item.id), ['update-exit']);
  await controller.handleKey({ name: 'escape' });
  assert.equal(controller.state.exitCode, 0);
  assert.notEqual(controller.state.updatePrompt, null);
});
