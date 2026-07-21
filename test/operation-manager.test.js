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
