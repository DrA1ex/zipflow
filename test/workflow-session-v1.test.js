import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SEMANTIC_ACTION_IDS,
  WorkflowSession,
  workflowActionFingerprint,
} from '../src/application/index.js';
import {
  SURFACE_KINDS,
  assertProtocolValue,
} from '../src/protocol/index.js';
import {
  MemoryWorkflowSessionRepository,
  actionInput,
  createWorkflowSession,
  recordForSurface,
} from './workflow-session-fixtures.js';

const ACTION_SURFACES = Object.freeze({
  'save-workflow': 'workflow_setup',
  'select-archive-root': 'archive_root_choice',
  'acknowledge-archive-safety': 'archive_safety',
  'approve-plan': 'plan_review',
  'use-archive': 'plan_files',
  'keep-local': 'plan_files',
  'resolve-conflict': 'conflict_file',
  'retry-run': 'archive_safety',
  'cancel-operation': 'archive_inspecting',
  'retry-checks': 'checks_failed',
  'prepare-commit': 'commit_choice',
  commit: 'commit_message',
  'continue-without-commit': 'commit_choice',
  deploy: 'deploy_choice',
  'skip-deploy': 'deploy_choice',
  finish: 'completed',
  rollback: 'rollback_confirm',
  'dismiss-error': 'error',
});

function hasCode(code) {
  return (error) => {
    assert.equal(error.name, 'ZipflowApiError');
    assert.equal(error.code, code);
    return true;
  };
}

test('authoritative workflow states map to every schema-valid semantic surface kind', async () => {
  const projected = [];
  for (const kind of SURFACE_KINDS) {
    const repository = new MemoryWorkflowSessionRepository(recordForSurface(kind));
    const session = createWorkflowSession(repository, {
      executeAction: () => assert.fail('surface reads must not execute actions'),
    }, kind);
    const surface = await session.getSurface('run-1');
    assertProtocolValue('surface', surface);
    assert.equal(surface.kind, kind);
    assert.equal(surface.revision, 10);
    projected.push(surface.kind);
  }
  assert.deepEqual(new Set(projected), new Set(SURFACE_KINDS));
});

test('every stable action persists intent before execution and receipt plus transition after it', async () => {
  assert.deepEqual(new Set(Object.keys(ACTION_SURFACES)), new Set(SEMANTIC_ACTION_IDS));

  for (const actionId of SEMANTIC_ACTION_IDS) {
    const repository = new MemoryWorkflowSessionRepository(
      recordForSurface(ACTION_SURFACES[actionId], { revision: 20 }),
    );
    let executorCalls = 0;
    const session = createWorkflowSession(repository, {
      executeAction: async (request) => {
        executorCalls += 1;
        const durable = repository.current();
        const pending = durable.actions.at(-1);
        assert.equal(durable.revision, 21, `${actionId} intent revision`);
        assert.equal(pending.intent.actionId, actionId);
        assert.equal(pending.intent.surfaceRevision, 20);
        assert.equal(pending.receipt, null);
        assert.equal(request.intent.actionIntentId, pending.intent.actionIntentId);
        return {
          snapshot: request.snapshot,
          result: { acceptedAction: actionId },
          evidence: { receiptId: `receipt-${actionId}` },
        };
      },
    }, actionId);

    const initial = await session.getSurface('run-1');
    assert.equal(initial.actions.some(({ id, enabled }) => id === actionId && enabled), true, actionId);
    const response = await session.dispatchAction({
      runId: 'run-1',
      actionId,
      expectedRevision: 20,
      input: actionInput(actionId),
      idempotencyKey: `key-${actionId}`,
    });
    const durable = repository.current();

    assert.equal(executorCalls, 1);
    assert.equal(response.replayed, false);
    assert.equal(response.settlement, 'succeeded');
    assert.equal(response.revision, 22);
    assert.equal(response.surface.revision, 22);
    assert.equal(durable.revision, 22);
    assert.equal(durable.actions.at(-1).receipt.settlement, 'succeeded');
    assert.deepEqual(durable.actions.at(-1).receipt.response.result, { acceptedAction: actionId });
  }
});

test('stale, disabled, unavailable, malformed, and schema-invalid requests never reach executor', async () => {
  let executorCalls = 0;
  const executor = {
    executeAction: async ({ snapshot }) => {
      executorCalls += 1;
      return { snapshot };
    },
  };

  const staleRepository = new MemoryWorkflowSessionRepository(recordForSurface('plan_review'));
  const stale = createWorkflowSession(staleRepository, executor, 'stale');
  await assert.rejects(stale.dispatchAction({
    runId: 'run-1', actionId: 'approve-plan', expectedRevision: 9,
    input: {}, idempotencyKey: 'stale-key',
  }), hasCode('STALE_REVISION'));
  assert.equal(staleRepository.casCalls, 0);

  const disabledRepository = new MemoryWorkflowSessionRepository(recordForSurface('conflict_summary'));
  const disabled = createWorkflowSession(disabledRepository, executor, 'disabled');
  await assert.rejects(disabled.dispatchAction({
    runId: 'run-1', actionId: 'approve-plan', expectedRevision: 10,
    input: {}, idempotencyKey: 'disabled-key',
  }), hasCode('ACTION_NOT_AVAILABLE'));
  assert.equal(disabledRepository.casCalls, 0);

  const invalidRepository = new MemoryWorkflowSessionRepository(recordForSurface('conflict_file'));
  const invalid = createWorkflowSession(invalidRepository, executor, 'invalid');
  await assert.rejects(invalid.dispatchAction({
    runId: 'run-1', actionId: 'resolve-conflict', expectedRevision: 10,
    input: { path: 'src/a.js', decision: 'merge' }, idempotencyKey: 'invalid-key',
  }), hasCode('ACTION_INPUT_INVALID'));
  await assert.rejects(invalid.dispatchAction({
    runId: 'run-1', actionId: 'run-command', expectedRevision: 10,
    input: {}, idempotencyKey: 'unknown-key',
  }), hasCode('ACTION_NOT_AVAILABLE'));
  await assert.rejects(invalid.dispatchAction({
    runId: 'run-1', actionId: 'resolve-conflict', expectedRevision: 10,
    input: {},
  }), hasCode('IDEMPOTENCY_REQUIRED'));

  assert.equal(executorCalls, 0);
  assert.equal(invalidRepository.casCalls, 0);
});

test('private executable state changes atomically without entering surface or response', async () => {
  const originalSecret = '/private/tmp/zipflow/extracted/source.js';
  const updatedSecret = '/Users/example/project/.zipflow/manifest.json';
  const repository = new MemoryWorkflowSessionRepository(recordForSurface('plan_review', {
    privateState: { manifestPath: originalSecret, generation: 1 },
  }));
  const session = createWorkflowSession(repository, {
    executeAction: async ({ snapshot, privateState }) => {
      assert.equal(privateState.manifestPath, originalSecret);
      privateState.manifestPath = updatedSecret;
      privateState.generation += 1;
      return {
        snapshot,
        privateState,
        result: { applied: true },
        evidence: { manifestHash: 'a'.repeat(64) },
      };
    },
  }, 'private');

  const response = await session.dispatchAction({
    runId: 'run-1', actionId: 'approve-plan', expectedRevision: 10,
    input: {}, idempotencyKey: 'private-key',
  });
  const durable = repository.current();
  const publicJson = JSON.stringify(response);

  assert.deepEqual(durable.privateState, { manifestPath: updatedSecret, generation: 2 });
  assert.doesNotMatch(publicJson, /private\/tmp|Users\/example|privateState|manifestPath/);
  assert.doesNotMatch(JSON.stringify(await session.getSurface('run-1')), /private\/tmp|Users\/example/);
});

test('absolute filesystem paths in executor public output become uncertain, never public', async () => {
  const repository = new MemoryWorkflowSessionRepository(recordForSurface('plan_review'));
  const session = createWorkflowSession(repository, {
    executeAction: async ({ snapshot }) => ({
      snapshot,
      result: { leakedPath: '/private/tmp/secret.txt' },
    }),
  }, 'leak');

  await assert.rejects(session.dispatchAction({
    runId: 'run-1', actionId: 'approve-plan', expectedRevision: 10,
    input: {}, idempotencyKey: 'leak-key',
  }), hasCode('INTERNAL_ERROR'));
  const durable = repository.current();
  assert.equal(durable.revision, 12);
  assert.equal(durable.actions[0].receipt.settlement, 'uncertain');
  assert.doesNotMatch(JSON.stringify(durable.actions[0].receipt), /private\/tmp|secret\.txt/);
  assert.doesNotMatch(JSON.stringify(await session.getSurface('run-1')), /private\/tmp|secret\.txt/);
});

test('fingerprints are canonical and application session has no terminal or server dependency', async () => {
  assert.equal(
    workflowActionFingerprint({ input: { b: 2, a: 1 } }),
    workflowActionFingerprint({ input: { a: 1, b: 2 } }),
  );
  assert.throws(() => new WorkflowSession(), /repository/);

  const source = await readFile(new URL('../src/application/workflow-session.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /terlio|\.\.\/server\/|\.\.\/app\/|child_process|selectedIndex|searchQuery/i);
  assert.equal(SEMANTIC_ACTION_IDS.some((id) => id.includes('command')), false);
});

