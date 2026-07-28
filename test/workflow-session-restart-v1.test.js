import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryWorkflowSessionRepository,
  createWorkflowSession,
  deferred,
  recordForSurface,
} from './workflow-session-fixtures.js';

const REQUEST = Object.freeze({
  runId: 'run-1',
  actionId: 'approve-plan',
  expectedRevision: 10,
  input: {},
  idempotencyKey: 'approve-key',
});

function hasCode(code) {
  return (error) => {
    assert.equal(error.name, 'ZipflowApiError');
    assert.equal(error.code, code);
    return true;
  };
}

function completed(snapshot) {
  return {
    ...snapshot,
    run: { ...snapshot.run, status: 'completed', attention: null },
  };
}

test('matching durable receipts replay after restart and conflicting key reuse is rejected', async () => {
  const repository = new MemoryWorkflowSessionRepository(recordForSurface('plan_review'));
  let executorCalls = 0;
  const executor = {
    executeAction: async ({ snapshot }) => {
      executorCalls += 1;
      return { snapshot: completed(snapshot), result: { applyId: 'apply-1' } };
    },
  };
  const firstSession = createWorkflowSession(repository, executor, 'first');
  const first = await firstSession.dispatchAction(REQUEST);
  assert.equal(first.replayed, false);
  assert.equal(first.revision, 12);

  const restarted = createWorkflowSession(repository, executor, 'restarted');
  const replay = await restarted.dispatchAction(REQUEST);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 12);
  assert.deepEqual(replay.receipt.response.result, { applyId: 'apply-1' });
  assert.equal(executorCalls, 1);
  assert.equal(repository.casCalls, 2);

  await assert.rejects(restarted.dispatchAction({
    ...REQUEST,
    expectedRevision: 12,
  }), hasCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(executorCalls, 1);
});

test('crash after durable intent leaves restart fail-closed before any side effect', async () => {
  const repository = new MemoryWorkflowSessionRepository(recordForSurface('plan_review'))
    .failOn(1, 'after', 'crash after intent');
  let executorCalls = 0;
  const executor = {
    executeAction: async ({ snapshot }) => {
      executorCalls += 1;
      return { snapshot };
    },
  };
  const firstSession = createWorkflowSession(repository, executor, 'intent-crash');
  await assert.rejects(firstSession.dispatchAction(REQUEST), /crash after intent/);

  assert.equal(repository.current().revision, 11);
  assert.equal(repository.current().actions[0].receipt, null);
  assert.equal(executorCalls, 0);

  const restarted = createWorkflowSession(repository, executor, 'intent-restart');
  assert.equal((await restarted.getSurface('run-1')).kind, 'operation_progress');
  await assert.rejects(restarted.dispatchAction(REQUEST), hasCode('STALE_REVISION'));
  await assert.rejects(restarted.dispatchAction({
    ...REQUEST,
    expectedRevision: 11,
    idempotencyKey: 'another-key',
  }), hasCode('OPERATION_BUSY'));
  assert.equal(executorCalls, 0);
});

test('crash after side effect but before receipt cannot execute the action twice', async () => {
  const repository = new MemoryWorkflowSessionRepository(recordForSurface('plan_review'))
    .failOn(2, 'before', 'crash before receipt');
  let executorCalls = 0;
  const executor = {
    executeAction: async ({ snapshot }) => {
      executorCalls += 1;
      return { snapshot: completed(snapshot), result: { applied: true } };
    },
  };
  const firstSession = createWorkflowSession(repository, executor, 'effect-crash');
  await assert.rejects(firstSession.dispatchAction(REQUEST), /crash before receipt/);
  assert.equal(executorCalls, 1);
  assert.equal(repository.current().revision, 11);
  assert.equal(repository.current().actions[0].receipt, null);

  const restarted = createWorkflowSession(repository, executor, 'effect-restart');
  await assert.rejects(restarted.dispatchAction(REQUEST), hasCode('STALE_REVISION'));
  await assert.rejects(restarted.dispatchAction({
    ...REQUEST,
    expectedRevision: 11,
    idempotencyKey: 'effect-new-key',
  }), hasCode('OPERATION_BUSY'));
  assert.equal(executorCalls, 1);
});

test('crash after atomic receipt, state, and privateState save replays without side effect', async () => {
  const oldPath = '/private/tmp/manifest-before.json';
  const newPath = '/private/tmp/manifest-after.json';
  const repository = new MemoryWorkflowSessionRepository(recordForSurface('plan_review', {
    privateState: { manifestPath: oldPath },
  })).failOn(2, 'after', 'response lost after receipt');
  let executorCalls = 0;
  const executor = {
    executeAction: async ({ snapshot, privateState }) => {
      executorCalls += 1;
      return {
        snapshot: completed(snapshot),
        privateState: { ...privateState, manifestPath: newPath },
        result: { applied: true },
      };
    },
  };
  const firstSession = createWorkflowSession(repository, executor, 'receipt-crash');
  await assert.rejects(firstSession.dispatchAction(REQUEST), /response lost after receipt/);

  const durable = repository.current();
  assert.equal(durable.revision, 12);
  assert.equal(durable.actions[0].receipt.settlement, 'succeeded');
  assert.equal(durable.snapshot.run.status, 'completed');
  assert.equal(durable.privateState.manifestPath, newPath);

  const restarted = createWorkflowSession(repository, executor, 'receipt-restart');
  const replay = await restarted.dispatchAction(REQUEST);
  assert.equal(replay.replayed, true);
  assert.equal(replay.surface.kind, 'completed');
  assert.equal(replay.surface.revision, 12);
  assert.equal(executorCalls, 1);
});

test('a concurrent request with the pre-intent revision is stale and never dispatched', async () => {
  const repository = new MemoryWorkflowSessionRepository(recordForSurface('plan_review'));
  const started = deferred();
  const release = deferred();
  let executorCalls = 0;
  const session = createWorkflowSession(repository, {
    executeAction: async ({ snapshot }) => {
      executorCalls += 1;
      started.resolve();
      await release.promise;
      return { snapshot: completed(snapshot) };
    },
  }, 'concurrent');

  const first = session.dispatchAction(REQUEST);
  await started.promise;
  assert.equal(repository.current().revision, 11);

  await assert.rejects(session.dispatchAction({
    ...REQUEST,
    idempotencyKey: 'concurrent-key',
  }), hasCode('STALE_REVISION'));
  assert.equal(executorCalls, 1);

  release.resolve();
  const result = await first;
  assert.equal(result.revision, 12);
  assert.equal(executorCalls, 1);
});

test('executor failure creates durable uncertain state that restart cannot retry', async () => {
  const repository = new MemoryWorkflowSessionRepository(recordForSurface('plan_review'));
  let executorCalls = 0;
  const executor = {
    executeAction: async () => {
      executorCalls += 1;
      throw new Error('executor connection ended');
    },
  };
  const firstSession = createWorkflowSession(repository, executor, 'uncertain');
  await assert.rejects(firstSession.dispatchAction(REQUEST), hasCode('INTERNAL_ERROR'));
  const durable = repository.current();
  assert.equal(durable.revision, 12);
  assert.equal(durable.actions[0].receipt.settlement, 'uncertain');
  assert.equal(durable.snapshot.run.status, 'uncertain');

  const restarted = createWorkflowSession(repository, executor, 'uncertain-restart');
  const surface = await restarted.getSurface('run-1');
  assert.equal(surface.kind, 'error');
  assert.equal(surface.revision, 12);
  await assert.rejects(restarted.dispatchAction({
    ...REQUEST,
    expectedRevision: 12,
    idempotencyKey: 'uncertain-new-key',
  }), hasCode('OPERATION_BUSY'));
  assert.equal(executorCalls, 1);
});

