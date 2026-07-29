import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticActionExecutor } from '../src/application/semantic-action-executor.js';

test('semantic executor changes private plan decisions without exposing executable paths', async () => {
  const operations = fakeOperations();
  const executor = new SemanticActionExecutor({
    operations,
    createOperationId: () => 'launch_fixture',
  });
  const request = actionRequest('resolve-conflict', {
    path: 'src/file.js',
    decision: 'keep',
  });
  const outcome = await executor.executeAction(request);
  assert.equal(outcome.privateState.decisions[0].decision, 'keep');
  assert.equal(outcome.snapshot.plan.unresolvedConflicts, 0);
  assert.equal(outcome.snapshot.run.attention, 'plan');
  assert.equal(JSON.stringify(outcome.snapshot).includes('/private/extracted'), false);
  assert.equal(request.privateState.decisions[0].decision, null);
});

test('semantic executor durably begins long operations before returning a launch descriptor', async () => {
  const operations = fakeOperations();
  const executor = new SemanticActionExecutor({
    operations,
    createOperationId: () => 'launch_fixture',
  });
  const request = actionRequest('approve-plan');
  request.privateState.decisions[0].decision = 'archive';
  const outcome = await executor.executeAction(request);
  assert.equal(operations.begun.length, 1);
  assert.equal(operations.begun[0].kind, 'apply');
  assert.equal(outcome.snapshot.run.status, 'applying');
  assert.equal(outcome.result.launch.operationId, 'operation_1');
  assert.equal(executor.takeOperationHandle('operation_1').operationId, 'operation_1');
  assert.equal(executor.takeOperationHandle('operation_1'), null);
});

test('semantic executor never accepts arbitrary action or deploy command input', async () => {
  const operations = fakeOperations();
  const executor = new SemanticActionExecutor({ operations });
  await assert.rejects(
    executor.executeAction(actionRequest('execute-command', { command: 'rm -rf .' })),
    (error) => error?.code === 'ACTION_NOT_AVAILABLE',
  );
  await assert.rejects(
    executor.executeAction(actionRequest('deploy')),
    (error) => error?.code === 'ACTION_NOT_AVAILABLE',
  );
  assert.equal(operations.begun.length, 0);
});

test('finish releases a failed check run instead of leaving the project busy', async () => {
  const executor = new SemanticActionExecutor({ operations: fakeOperations() });
  const request = actionRequest('finish');
  request.snapshot.run.attention = 'checks_failed';
  request.snapshot.checks = { status: 'failed' };
  const outcome = await executor.executeAction(request);
  assert.equal(outcome.snapshot.run.status, 'completed');
  assert.equal(outcome.snapshot.run.attention, null);
  assert.equal(outcome.snapshot.checks.status, 'failed');
  assert.equal(outcome.result, null);
});

function actionRequest(actionId, input = {}) {
  return {
    runId: 'run_fixture',
    actionId,
    actionKind: actionId.replaceAll('-', '_'),
    input,
    intent: { actionIntentId: 'intent_fixture' },
    snapshot: {
      project: { id: 'project_fixture', name: 'fixture' },
      workflow: {
        configured: true,
        deployment: { configured: false },
      },
      run: {
        id: 'run_fixture',
        status: 'waiting_action',
        attention: 'conflicts',
      },
      plan: {
        counts: { created: 0, updated: 1, deleted: 0, conflicts: 1 },
        files: [{
          id: 'src/file.js',
          path: 'src/file.js',
          kind: 'updated',
          change: 'updated',
          decision: null,
        }],
        groups: [{ id: 'updated', label: 'updated', count: 1 }],
        conflicts: [{
          id: 'src/file.js',
          path: 'src/file.js',
          reason: 'fixture conflict',
          decision: null,
        }],
        unresolvedConflicts: 1,
        selected: 0,
      },
    },
    privateState: {
      version: 1,
      binding: {
        runId: 'run_fixture',
        projectId: 'project_fixture',
        projectPath: '/project/fixture',
        workflowRevision: 1,
      },
      workflow: {
        version: 9,
        projectPath: '/project/fixture',
        checks: [],
        git: { resultCommit: 'never' },
        deploy: { policy: 'disabled', commandText: '', cwd: '.' },
      },
      plan: {
        created: [],
        updated: [{
          kind: 'updated',
          path: 'src/file.js',
          sourcePath: '/private/extracted/src/file.js',
          currentPath: '/project/fixture/src/file.js',
        }],
        deleted: [],
        conflicts: [{ kind: 'updated', path: 'src/file.js' }],
        preserved: [],
      },
      decisions: [{ path: 'src/file.js', kind: 'updated', decision: null }],
      safety: { warnings: [], acknowledged: true },
    },
  };
}

function fakeOperations() {
  const begun = [];
  return {
    begun,
    async begin(options) {
      begun.push(options);
      return {
        operationId: `operation_${begun.length}`,
        signal: new AbortController().signal,
      };
    },
    async requestCancellation(operationId) {
      return {
        status: 202,
        operation: { operationId, settlement: 'cancel_requested' },
      };
    },
  };
}
