import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { WorkflowSession } from '../src/application/workflow-session.js';
import { RunSessionStore } from '../src/server/run-session-store.js';

test('WorkflowSession persists intent+dispatch and receipt+snapshot as two atomic durable CAS records', async (t) => {
  const fixture = await setup(t, 'run-workflow-atomic');
  const store = await new RunSessionStore({ runsRoot: fixture.runsRoot, now: tickingClock() }).initialize();
  await store.create(runOptions(fixture));
  const original = await store.get(fixture.runId);
  let observedDuringExecution = null;
  const session = new WorkflowSession({
    repository: store.workflowRepository(),
    idFactory: () => 'intent-atomic',
    clock: tickingClock(),
    executor: {
      executeAction: async ({ snapshot }) => {
        observedDuringExecution = await store.get(fixture.runId);
        return {
          snapshot: {
            ...snapshot,
            run: { ...snapshot.run, status: 'completed', attention: null },
          },
          result: { applied: true },
          evidence: { operationId: 'operation-1' },
        };
      },
    },
  });

  const surface = await session.getSurface(fixture.runId);
  assert.equal(surface.kind, 'plan_review');
  assert.equal(surface.revision, 1);
  assert.ok(surface.actions.some(({ id, enabled }) => id === 'approve-plan' && enabled));
  const response = await session.dispatchAction({
    runId: fixture.runId,
    actionId: 'approve-plan',
    expectedRevision: 1,
    idempotencyKey: 'workflow-action-1',
  });

  assert.equal(observedDuringExecution.revision, 2);
  assert.equal(observedDuringExecution.actions.length, 1);
  assert.equal(observedDuringExecution.actions[0].intent.actionIntentId, 'intent-atomic');
  assert.equal(observedDuringExecution.actions[0].dispatch.attempt, 1);
  assert.equal(observedDuringExecution.actions[0].receipt, null);
  assert.equal(response.revision, 3);
  assert.equal(response.settlement, 'succeeded');
  assert.equal(response.surface.kind, 'completed');

  const persisted = await store.get(fixture.runId);
  assert.equal(persisted.revision, 3);
  assert.equal(persisted.publicSummary.run.status, 'completed');
  assert.equal(persisted.run.status, 'completed');
  assert.equal(persisted.actions[0].receipt.settlement, 'succeeded');
  assert.deepEqual(persisted.binding, original.binding);
  assert.equal(persisted.run.operationId, null);
  assert.ok(persisted.run.completedAt);

  const restartedStore = await new RunSessionStore({ runsRoot: fixture.runsRoot }).initialize();
  const restartedSession = new WorkflowSession({
    repository: restartedStore.workflowRepository(),
    executor: { executeAction: async () => assert.fail('idempotent replay must not execute') },
  });
  const replay = await restartedSession.dispatchAction({
    runId: fixture.runId,
    actionId: 'approve-plan',
    expectedRevision: 1,
    idempotencyKey: 'workflow-action-1',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 3);
});

test('executor crash durably blocks restart as uncertain without retrying side effects', async (t) => {
  const fixture = await setup(t, 'run-workflow-crash');
  const store = await new RunSessionStore({ runsRoot: fixture.runsRoot, now: tickingClock() }).initialize();
  await store.create(runOptions(fixture));
  let calls = 0;
  const crashing = new WorkflowSession({
    repository: store.workflowRepository(),
    idFactory: () => 'intent-crash',
    clock: tickingClock(),
    executor: {
      executeAction: async () => {
        calls += 1;
        throw new Error('connection lost after side effect');
      },
    },
  });

  await assert.rejects(
    crashing.dispatchAction({
      runId: fixture.runId, actionId: 'approve-plan', expectedRevision: 1,
      idempotencyKey: 'workflow-crash-1',
    }),
    (error) => error?.code === 'INTERNAL_ERROR',
  );
  assert.equal(calls, 1);
  const persisted = await store.get(fixture.runId);
  assert.equal(persisted.revision, 3);
  assert.equal(persisted.publicSummary.run.status, 'uncertain');
  assert.equal(persisted.run.status, 'uncertain');
  assert.equal(persisted.actions[0].receipt.settlement, 'uncertain');
  assert.equal((await store.listRecoveryActions(fixture.runId))[0].recovery, 'reconcile_required');

  const restartedStore = await new RunSessionStore({ runsRoot: fixture.runsRoot }).initialize();
  const restarted = new WorkflowSession({
    repository: restartedStore.workflowRepository(),
    executor: { executeAction: async () => { calls += 1; } },
  });
  assert.equal((await restarted.getSurface(fixture.runId)).kind, 'error');
  await assert.rejects(
    restarted.dispatchAction({
      runId: fixture.runId, actionId: 'dismiss-error', expectedRevision: 3,
      idempotencyKey: 'workflow-after-crash',
    }),
    (error) => error?.code === 'OPERATION_BUSY',
  );
  assert.equal(calls, 1);
});

test('WorkflowSession adapter returns false on stale CAS and cannot replace run identity', async (t) => {
  const fixture = await setup(t, 'run-workflow-cas');
  const store = await new RunSessionStore({ runsRoot: fixture.runsRoot, now: tickingClock() }).initialize();
  await store.create(runOptions(fixture));
  const repository = store.workflowRepository();
  const current = await repository.load(fixture.runId);
  const next = {
    ...current,
    revision: 2,
    snapshot: { ...current.snapshot, surfaceSummary: 'changed' },
  };
  assert.equal((await repository.compareAndSwap(fixture.runId, 1, next)).revision, 2);
  assert.equal(await repository.compareAndSwap(fixture.runId, 1, next), false);
  await assert.rejects(
    repository.compareAndSwap(fixture.runId, 2, { ...next, runId: 'other', revision: 3 }),
    (error) => error?.code === 'WORKFLOW_RECORD_INVALID',
  );
  assert.equal((await store.get(fixture.runId)).run.runId, fixture.runId);
});

async function setup(t, runId) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-workflow-store-'));
  const runsRoot = path.join(root, 'runs');
  const runDirectory = path.join(runsRoot, runId);
  const projectPath = path.join(root, 'project');
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await mkdir(projectPath, { recursive: true });
  await writeFile(path.join(runDirectory, 'report.json'), `${JSON.stringify({ id: runId, projectPath })}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, runsRoot, runId, projectPath };
}

function runOptions(fixture) {
  const hash = 'b'.repeat(64);
  return {
    runId: fixture.runId,
    binding: {
      projectId: 'project-fixture', projectPath: fixture.projectPath, workflowRevision: 4,
      blobId: `sha256:${hash}`, blobSha256: hash,
    },
    kind: 'archive',
    status: 'waiting_action',
    executionManifest: {
      created: [{
        kind: 'created', path: 'src/app.js',
        sourcePath: path.join(fixture.root, 'extracted', 'src', 'app.js'),
        currentPath: path.join(fixture.projectPath, 'src', 'app.js'),
      }],
      updated: [], deleted: [], preserved: [], unchanged: [], skipped: [], conflicts: [],
    },
    publicSummary: {
      project: { id: 'project-fixture', name: 'Fixture' },
      run: { id: fixture.runId, status: 'waiting_action', attention: 'plan' },
      plan: { files: [{ id: 'src-app', path: 'src/app.js', kind: 'created' }], groups: [], conflicts: [] },
    },
  };
}

function tickingClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 28, 1, 0, tick++));
}
