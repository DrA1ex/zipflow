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

test('semantic executor preserves the original Git checkpoint choice before conflict apply', async () => {
  const operations = fakeOperations();
  const executor = new SemanticActionExecutor({
    operations,
    createOperationId: () => 'launch_fixture',
  });
  const approval = actionRequest('approve-plan');
  approval.privateState.decisions[0].decision = 'archive';
  approval.privateState.plan.gitStatus = { staged: [], unstaged: [], conflicted: [] };
  approval.privateState.conflicts = [{ kind: 'updated', path: 'src/file.js' }];
  approval.privateState.workflow.git.checkpoint = 'ask';
  const choice = await executor.executeAction(approval);
  assert.equal(choice.snapshot.run.attention, 'checkpoint');
  assert.equal(operations.begun.length, 0);

  const checkpointRequest = {
    ...approval,
    actionId: 'create-checkpoint',
    actionKind: 'create_checkpoint',
    snapshot: choice.snapshot,
    privateState: choice.privateState,
  };
  const checkpoint = await executor.executeAction(checkpointRequest);
  assert.equal(operations.begun[0].kind, 'checkpoint_apply');

  const withoutRequest = {
    ...approval,
    actionId: 'continue-without-checkpoint',
    actionKind: 'continue_without_checkpoint',
    snapshot: choice.snapshot,
    privateState: choice.privateState,
  };
  const without = await executor.executeAction(withoutRequest);
  assert.equal(operations.begun[1].kind, 'apply');
  assert.equal(without.privateState.checkpointResolution, 'skipped');
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

test('keeping changes after failed checks preserves the original commit choice and skips deploy by default', async () => {
  const executor = new SemanticActionExecutor({ operations: fakeOperations() });
  const request = actionRequest('keep-changes');
  request.snapshot.run.attention = 'checks_failed';
  request.privateState.checks = { ok: false, failed: 1, results: [] };
  request.privateState.applied = { paths: ['src/file.js'], changedPaths: ['src/file.js'] };
  request.privateState.workflow.git.resultCommit = 'ask';
  request.privateState.workflow.deploy = {
    policy: 'ask',
    commandText: 'npm run deploy',
    cwd: '.',
  };
  const kept = await executor.executeAction(request);
  assert.equal(kept.snapshot.run.attention, 'commit');
  assert.equal(kept.privateState.failedChecksKept, true);

  const skippedCommit = await executor.executeAction({
    ...request,
    actionId: 'continue-without-commit',
    actionKind: 'continue_without_commit',
    snapshot: kept.snapshot,
    privateState: kept.privateState,
  });
  assert.equal(skippedCommit.snapshot.run.status, 'completed');
  assert.equal(skippedCommit.snapshot.run.attention, null);
});

test('failed deployment retry and finish remain distinct semantic actions', async () => {
  const operations = fakeOperations();
  const executor = new SemanticActionExecutor({ operations });
  const request = actionRequest('retry-deploy');
  request.snapshot.run.attention = 'deploy';
  request.privateState.workflow.deploy = {
    policy: 'ask',
    commandText: 'npm run deploy',
    cwd: '.',
  };
  request.privateState.deploy = { ok: false, code: 1 };
  const retried = await executor.executeAction(request);
  assert.equal(retried.result.launch.kind, 'deploy');

  const finished = await executor.executeAction({
    ...request,
    actionId: 'finish-with-deploy-error',
    actionKind: 'finish_with_deploy_error',
  });
  assert.equal(finished.snapshot.run.status, 'completed');
  assert.equal(finished.privateState.deploy.failureAccepted, true);
});

test('interactive archive review controls stay durable semantic actions', async () => {
  const operations = fakeOperations();
  const executor = new SemanticActionExecutor({ operations });
  const reinterpret = actionRequest('reinterpret-as-snapshot');
  reinterpret.privateState.binding.blob = {
    path: '/private/blob.zip',
    blobId: `sha256:${'a'.repeat(64)}`,
    sha256: 'a'.repeat(64),
    size: 10,
  };
  reinterpret.privateState.workflow.archive = { mode: 'overlay' };
  reinterpret.privateState.archiveInterpretation = { mode: 'overlay', source: 'workflow' };
  const reinterpreted = await executor.executeAction(reinterpret);
  assert.equal(reinterpreted.result.launch.kind, 'archive_reinterpretation');
  assert.equal(reinterpreted.result.launch.input.mode, 'snapshot');
  assert.equal(reinterpreted.privateState.workflow.archive.mode, 'snapshot');
  assert.equal(reinterpreted.privateState.llmReviewStatus, null);

  const restart = actionRequest('restart-llm-review');
  restart.privateState.llmReviewStatus = 'failed';
  const restarted = await executor.executeAction(restart);
  assert.equal(restarted.result.launch.kind, 'llm_review');
  assert.equal(restarted.privateState.llmReviewStatus, 'running');
  assert.equal(restarted.snapshot.operation.kind, 'llm_review');

  const resume = actionRequest('resume-autopilot');
  resume.privateState.autonomy = { mode: 'guarded', paused: true };
  resume.snapshot.autonomy = { mode: 'guarded', paused: true };
  const resumed = await executor.executeAction(resume);
  assert.equal(resumed.privateState.autonomy.paused, false);
  assert.equal(resumed.snapshot.autonomy.paused, false);
  assert.equal(resumed.result.resumeAutonomy, true);

  const cancelled = await executor.executeAction(actionRequest('cancel-run'));
  assert.equal(cancelled.snapshot.run.status, 'cancelled');
  assert.equal(cancelled.snapshot.run.attention, null);
  assert.equal(cancelled.privateState.cancelled, true);
});

test('eligible commit rewrites are immutable server-owned operations', async () => {
  const operations = fakeOperations();
  const executor = new SemanticActionExecutor({ operations });
  const request = actionRequest('amend-commit', {
    targetId: 'amend-head',
    message: 'Update project',
  });
  request.privateState.commitRewriteCandidates = [{
    id: 'amend-head',
    kind: 'amend',
    revision: 'abc123',
    runIds: ['previous-run'],
  }];
  const amended = await executor.executeAction(request);
  assert.equal(amended.result.launch.kind, 'git_rewrite');
  assert.deepEqual(amended.result.launch.input, {
    strategy: 'amend',
    targetId: 'amend-head',
    message: 'Update project',
  });

  await assert.rejects(
    executor.executeAction({
      ...request,
      actionId: 'squash-commits',
      actionKind: 'squash_commits',
    }),
    (error) => error?.code === 'ACTION_NOT_AVAILABLE',
  );
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
