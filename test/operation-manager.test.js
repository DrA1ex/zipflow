import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationManager } from '../src/operations/manager.js';
import { runProcess } from '../src/utils/process.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';

test('Ctrl+C semantics cancel the active operation before an idle interrupt exits', async () => {
  let forceStops = 0;
  const snapshots = [];
  const manager = new OperationManager({
    onChange: (value) => snapshots.push(value),
    forceStop: async () => { forceStops += 1; },
  });
  const operation = manager.begin({ kind: 'checks', label: 'Running checks' });
  const first = await manager.interrupt();
  assert.equal(first.cancelling, true);
  assert.equal(operation.signal.aborted, true);
  assert.equal(manager.current.cancelling, true);
  const second = await manager.interrupt();
  assert.equal(second.forced, true);
  assert.equal(forceStops, 1);
  operation.finish();
  const third = await manager.interrupt();
  assert.equal(third.handled, false);
  assert.equal(third.exited, true);
  assert.ok(snapshots.some((value) => value?.cancelRequested));
});

test('an idle controller Ctrl+C exits, while an active operation keeps the app open', async () => {
  const state = createInitialState();
  const exits = [];
  const controller = new ZipflowController(state);
  controller.attachRuntime({ invalidate() {}, exit: (code) => exits.push(code) });
  const operation = controller.beginOperation({ kind: 'llm', label: 'Generating' });
  await controller.handleKey({ name: 'c', ctrl: true });
  assert.deepEqual(exits, []);
  assert.equal(operation.signal.aborted, true);
  operation.finish();
  await controller.handleKey({ name: 'c', ctrl: true });
  assert.deepEqual(exits, [0]);
});

test('cancelling a process-backed operation terminates the child and reports cancellation', async () => {
  const abortController = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: abortController.signal,
    timeoutMs: 30_000,
  });
  setTimeout(() => abortController.abort('cancelled'), 30);
  await assert.rejects(pending, (error) => error.code === 'cancelled');
});

test('critical operations defer the first Ctrl+C until the atomic section finishes', async () => {
  let forceStops = 0;
  const manager = new OperationManager({ forceStop: async () => { forceStops += 1; } });
  const operation = manager.begin({ kind: 'apply', label: 'Applying files', critical: true });
  const first = await manager.interrupt();
  assert.equal(first.waitingForCritical, true);
  assert.equal(operation.signal.aborted, false);
  assert.equal(operation.isCancellationRequested(), true);
  const second = await manager.interrupt();
  assert.equal(second.forced, true);
  assert.equal(forceStops, 1);
  assert.equal(operation.signal.aborted, false, 'filesystem critical sections are not interrupted mid-transaction');
  operation.leaveCritical('between transactions');
  assert.equal(operation.signal.aborted, true);
  operation.finish();
});


test('operation handoff releases the current phase before the next phase begins', async () => {
  const manager = new OperationManager();
  const apply = manager.begin({ kind: 'apply', label: 'Applying update' });
  const next = await apply.handoff(async () => {
    assert.equal(manager.current, null);
    const checks = manager.begin({ kind: 'checks', label: 'Running checks' });
    assert.equal(manager.current.kind, 'checks');
    checks.finish();
    return 'checks-started';
  });
  assert.equal(next, 'checks-started');
  assert.equal(manager.current, null);
  apply.finish();
});

test('operation conflicts expose a typed busy error instead of a generic failure', () => {
  const manager = new OperationManager();
  const llm = manager.begin({ kind: 'llm-review', label: 'Reviewing update' });
  assert.throws(
    () => manager.begin({ kind: 'apply', label: 'Applying update' }),
    (error) => error.code === 'operation-busy'
      && error.requestedOperation === 'apply'
      && error.activeOperation === 'llm-review',
  );
  llm.finish();
});

test('controller keeps the current screen when an operation conflict reaches the safety net', async () => {
  const state = createInitialState();
  state.screen = 'plan-review';
  const toasts = [];
  const controller = new ZipflowController(state);
  controller.attachRuntime({
    invalidate() {},
    overlays: { toast: (...args) => toasts.push(args) },
  });
  const llm = controller.beginOperation({ kind: 'llm-review', label: 'Generating local LLM review' });
  let error;
  try {
    controller.beginOperation({ kind: 'apply', label: 'Applying update' });
  } catch (caught) {
    error = caught;
  }
  await controller.handleUnexpected(error);
  assert.equal(state.screen, 'plan-review');
  assert.equal(controller.recovery, undefined);
  assert.match(state.status, /still running/i);
  assert.equal(toasts.length, 1);
  llm.finish();
});

test('scoped operations always release ownership after success and failure', async () => {
  const manager = new OperationManager();
  const value = await manager.run({ kind: 'success' }, async (operation) => {
    assert.equal(manager.current.kind, 'success');
    assert.equal(operation.signal.aborted, false);
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(manager.current, null);

  await assert.rejects(
    manager.run({ kind: 'failure' }, async () => { throw new Error('checkpoint failed'); }),
    /checkpoint failed/,
  );
  assert.equal(manager.current, null);
});
