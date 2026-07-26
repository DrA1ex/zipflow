import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { OperationManager } from '../src/operations/manager.js';
import { OPERATION_STATES, operationCapabilities } from '../src/operations/state.js';
import { InputActionGate } from '../src/app/input-action-gate.js';
import { verifyInstalledUpdate } from '../src/update/service.js';
import { completePath } from '../src/utils/paths.js';

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeInstalledPackage(root, { metadataVersion, executableVersion }) {
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'zipflow', version: metadataVersion, type: 'module', bin: { zipflow: './bin/zipflow.js' },
  }));
  await writeFile(path.join(root, 'bin', 'zipflow.js'), `process.stdout.write(${JSON.stringify(`${executableVersion}\n`)});\n`);
}

test('operation snapshots expose one lifecycle state and derived UI capabilities', async () => {
  const snapshots = [];
  const manager = new OperationManager({ onChange: (snapshot) => snapshots.push(snapshot) });
  const operation = manager.begin({ kind: 'apply', label: 'Applying update' });

  assert.equal(manager.snapshot().state, OPERATION_STATES.RUNNING);
  assert.equal(manager.snapshot().capabilities.canApply, false);
  assert.equal(manager.snapshot().capabilities.canCancel, true);
  operation.update({ state: 'completed', phase: 'Preparing files' });
  assert.equal(manager.snapshot().state, OPERATION_STATES.RUNNING);
  operation.enterCritical('Replacing files');
  assert.equal(manager.snapshot().state, OPERATION_STATES.CRITICAL);

  const interruption = await manager.requestCancellation();
  assert.equal(interruption.waitingForCritical, true);
  assert.equal(manager.snapshot().state, OPERATION_STATES.CANCELLING);
  assert.equal(operation.signal.aborted, false);

  operation.leaveCritical('Between files');
  assert.equal(operation.signal.aborted, true);
  operation.finish('cancelled');

  assert.equal(manager.snapshot(), null);
  assert.equal(operationCapabilities(null).canApply, true);
  assert.equal(await operation.completion.then((snapshot) => snapshot.outcome), 'cancelled');
  assert.equal(snapshots.at(-1), null);
});

test('scoped operation execution records failed and cancelled outcomes without terminal active states', async () => {
  const activeStates = [];
  const manager = new OperationManager({ onChange: (snapshot) => { if (snapshot) activeStates.push(snapshot.state); } });

  await assert.rejects(manager.run({ kind: 'checks' }, async () => { throw new Error('failed'); }), /failed/);
  await assert.rejects(manager.run({ kind: 'checks' }, async () => {
    const error = new Error('cancelled');
    error.code = 'cancelled';
    throw error;
  }), /cancelled/);

  assert.equal(activeStates.every((state) => ['running', 'critical', 'cancelling'].includes(state)), true);
  assert.equal(manager.snapshot(), null);
});

test('operation handoff closes the previous owner before the next operation begins', () => {
  const snapshots = [];
  const manager = new OperationManager({ onChange: (snapshot) => snapshots.push(snapshot?.kind ?? 'idle') });
  const first = manager.begin({ kind: 'archive-inspection' });

  const second = first.handoff(() => manager.begin({ kind: 'llm-review' }));

  assert.equal(manager.snapshot().kind, 'llm-review');
  assert.deepEqual(snapshots, ['archive-inspection', 'idle', 'llm-review']);
  second.finish();
});

test('operation waiters do not report idle before a critical owner finishes', async () => {
  const manager = new OperationManager();
  const operation = manager.begin({ kind: 'rollback', critical: true });
  const safeBoundary = manager.waitForSafeBoundary({ timeoutMs: 500 });
  const idle = manager.waitForIdle({ timeoutMs: 500 });

  operation.leaveCritical();
  assert.equal(await safeBoundary, true);
  let idleResolved = false;
  void idle.then((value) => { idleResolved = value; });
  await Promise.resolve();
  assert.equal(idleResolved, false);
  operation.finish();
  assert.equal(await idle, true);
});

test('local input action gate rejects duplicate submissions without serializing navigation', async () => {
  const gate = new InputActionGate();
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const first = gate.run(async () => { calls += 1; await blocker; });
  const duplicate = await gate.run(async () => { calls += 1; });
  assert.equal(duplicate, false);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
  assert.equal(await gate.run(async () => { calls += 1; }), true);
  assert.equal(calls, 2);
});



test('superseded path completion exits with a typed cancellation', async () => {
  const root = await temporaryDirectory('zipflow-path-cancel-');
  await mkdir(path.join(root, 'child'));
  const controller = new AbortController();
  controller.abort('superseded');

  await assert.rejects(
    completePath(path.join(root, 'ch'), { directoriesOnly: true, signal: controller.signal }),
    (error) => error?.code === 'cancelled',
  );
});

test('self-update verification never probes a package executable outside its installation root', async () => {
  const root = await temporaryDirectory('zipflow-update-escape-');
  const outside = `${root}-outside-probe.js`;
  await writeFile(outside, 'throw new Error("must not execute");\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'zipflow', version: '1.3.4', type: 'module', bin: { zipflow: `../${path.basename(outside)}` },
  }));
  let called = false;

  const verification = await verifyInstalledUpdate({
    previousVersion: '1.3.3', targetVersion: '1.3.4', installation: { installedPath: root },
  }, { run: async () => { called = true; return { ok: true, stdout: '1.3.4\n' }; } });

  assert.equal(verification.status, 'uncertain');
  assert.match(verification.detail, /outside/i);
  assert.equal(called, false);
});

test('self-update verification distinguishes updated, unchanged, and uncertain installs', async () => {
  const root = await temporaryDirectory('zipflow-update-verify-');
  await writeInstalledPackage(root, { metadataVersion: '1.3.4', executableVersion: '1.3.4' });
  const updated = await verifyInstalledUpdate({
    previousVersion: '1.3.3', targetVersion: '1.3.4', installation: { installedPath: root },
  });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.executableExists, true);
  assert.equal(updated.probeVersion, '1.3.4');

  await writeInstalledPackage(root, { metadataVersion: '1.3.3', executableVersion: '1.3.3' });
  const unchanged = await verifyInstalledUpdate({
    previousVersion: '1.3.3', targetVersion: '1.3.4', installation: { installedPath: root },
  });
  assert.equal(unchanged.status, 'unchanged');

  await writeInstalledPackage(root, { metadataVersion: '1.3.4', executableVersion: '1.3.3' });
  const uncertain = await verifyInstalledUpdate({
    previousVersion: '1.3.3', targetVersion: '1.3.4', installation: { installedPath: root },
  });
  assert.equal(uncertain.status, 'uncertain');
  assert.match(uncertain.detail, /do not agree/i);
});
