import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWorkspaceApp, parseInputEvent, Text } from 'terlio.js';
import { checkReorderDirection, normalizeZipflowKey, shiftArrowDirection } from '../src/app/key-normalization.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { showChecksStep } from '../src/app/setup-checks.js';
import { createInterruptAwareInput } from '../src/ui/interrupt-input.js';

test('Terlio raw Shift+arrow input keeps its modifier through Zipflow normalization', () => {
  const up = normalizeZipflowKey(parseInputEvent('\x1b[1;2A'));
  const down = normalizeZipflowKey(parseInputEvent('\x1b[1;2B'));

  assert.equal(up.name, 'up');
  assert.equal(up.shift, true);
  assert.equal(shiftArrowDirection(up), -1);
  assert.equal(down.name, 'down');
  assert.equal(down.shift, true);
  assert.equal(shiftArrowDirection(down), 1);
});

test('Zipflow recovers Shift+arrow intent from sequence, aliases, and modifier collections', () => {
  assert.equal(shiftArrowDirection({ name: 'up', shift: false, sequence: '\x1b[1;2A' }), -1);
  assert.equal(shiftArrowDirection({ name: 'shift-down' }), 1);
  assert.equal(shiftArrowDirection({ name: 'up', modifiers: ['shift'] }), -1);
  assert.equal(shiftArrowDirection({ name: 'down', modifiers: { shift: true } }), 1);
  assert.equal(shiftArrowDirection({ name: 'up', shift: false, sequence: '\x1b[A' }), 0);
});


test('Terlio 1.2.1 normalizes Shift+K/J and Zipflow uses it for portable reordering', () => {
  const upperK = parseInputEvent('K');
  const upperJ = parseInputEvent('J');
  assert.equal(upperK.name, 'k');
  assert.equal(upperK.shift, true);
  assert.equal(upperJ.name, 'j');
  assert.equal(upperJ.shift, true);
  assert.equal(checkReorderDirection(upperK), -1);
  assert.equal(checkReorderDirection(upperJ), 1);
  assert.equal(checkReorderDirection(parseInputEvent('k')), 0);
  assert.equal(checkReorderDirection(parseInputEvent('j')), 0);
  assert.equal(checkReorderDirection(parseInputEvent('\x1b[A')), 0);
  assert.equal(checkReorderDirection(parseInputEvent('\x1b[B')), 0);
});


class FakeInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.rawMode = false;
  }

  setEncoding() {}
  setRawMode(value) { this.rawMode = Boolean(value); }
  resume() {}
  pause() {}
}

class FakeOutput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.columns = 90;
    this.rows = 28;
  }

  write() { return true; }
}

test('raw TTY Shift+arrow bytes reorder a check through Terlio WorkspaceApp and Zipflow routing', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const state = createInitialState();
  state.screen = 'setup-checks';
  state.draft = {
    checks: [
      { id: 'lint', name: 'Lint', selected: true },
      { id: 'test', name: 'Tests', selected: true },
      { id: 'types', name: 'Types', selected: true },
    ],
  };
  const controller = new ZipflowController(state);
  showChecksStep(controller, 1);

  const app = createWorkspaceApp({
    state,
    input: createInterruptAwareInput(input),
    output,
    processHandlers: 'none',
    render: () => Text('Shift reorder test'),
    onKey: ({ key }) => { void controller.handleKey(key); },
  });
  controller.attachRuntime(app);

  app.start();
  try {
    input.emit('data', '\x1b[1;2A');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(state.draft.checks.map((check) => check.id), ['test', 'lint', 'types']);
    assert.equal(state.menuItems[state.selectedIndex].id, 'check:0');
    assert.equal(state.status, 'Check moved up');
  } finally {
    app.stop();
  }
});


test('raw printable Shift+K reorders a check through Terlio WorkspaceApp', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const state = createInitialState();
  state.screen = 'setup-checks';
  state.draft = {
    checks: [
      { id: 'lint', name: 'Lint', selected: true },
      { id: 'test', name: 'Tests', selected: true },
      { id: 'types', name: 'Types', selected: true },
    ],
  };
  const controller = new ZipflowController(state);
  showChecksStep(controller, 1);

  const app = createWorkspaceApp({
    state,
    input: createInterruptAwareInput(input),
    output,
    processHandlers: 'none',
    render: () => Text('Printable reorder test'),
    onKey: ({ key }) => { void controller.handleKey(key); },
  });
  controller.attachRuntime(app);

  app.start();
  try {
    input.emit('data', 'K');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(state.draft.checks.map((check) => check.id), ['test', 'lint', 'types']);
    assert.equal(state.menuItems[state.selectedIndex].id, 'check:0');
    assert.equal(state.status, 'Check moved up');
  } finally {
    app.stop();
  }
});
