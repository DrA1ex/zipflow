import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendWorkflowAutonomyDecision,
  decideWorkflowAutonomy,
  nextWorkflowAutonomyGate,
  publicWorkflowAutonomyDecision,
  workflowAutonomyEnabled,
} from '../src/application/workflow-autonomy-coordinator.js';

test('full server autopilot resolves conflict decisions only through semantic actions', async () => {
  const session = autonomySession({
    mode: 'full',
    attention: 'conflicts',
    privateChanges: {
      conflicts: [{ path: 'src/a.js', reason: 'both changed' }],
      decisions: [{ path: 'src/a.js', decision: null }],
    },
  });
  const gate = nextWorkflowAutonomyGate(session);
  assert.equal(workflowAutonomyEnabled(session.executionManifest), true);
  assert.equal(gate.gate, 'file-conflict');
  assert.deepEqual(gate.allowedActions, ['use-archive', 'keep-local', 'ask-user', 'abort']);

  const result = await decideWorkflowAutonomy({
    session,
    gate,
    requestDecision: async () => acceptedDecision({
      gate: 'file-conflict',
      action: 'use-archive',
      summary: 'The archive version matches the planned update.',
    }),
  });
  assert.deepEqual(result.actions, [{
    actionId: 'resolve-conflict',
    input: { path: 'src/a.js', decision: 'archive' },
  }]);
  const next = appendWorkflowAutonomyDecision(session.executionManifest, result);
  assert.equal(next.decisions[0].decision, null, 'plan selections remain separate');
  assert.equal(next.autonomyDecisions[0].gate, 'file-conflict');
  assert.deepEqual(next.autonomy.decisions, ['decision-1']);
  assert.equal(JSON.stringify(publicWorkflowAutonomyDecision(result.record)).includes('/private/'), false);
});

test('guarded server autopilot pauses on high-risk plan and advances a routine plan', async () => {
  const risky = autonomySession({
    mode: 'guarded',
    attention: 'plan',
    privateChanges: {
      safety: {
        warnings: [{ id: 'suspicious', detail: 'Review this archive.' }],
        llm: { assessment: 'suspicious' },
      },
    },
  });
  assert.equal(nextWorkflowAutonomyGate(risky), null);

  const routine = autonomySession({ mode: 'guarded', attention: 'plan' });
  const gate = nextWorkflowAutonomyGate(routine);
  assert.equal(gate.gate, 'plan-application');
  const result = await decideWorkflowAutonomy({
    session: routine,
    gate,
    requestDecision: async () => acceptedDecision({
      gate: 'plan-application',
      action: 'apply',
      summary: 'The deterministic plan is routine and reversible.',
    }),
  });
  assert.deepEqual(result.actions, [{ actionId: 'approve-plan', input: {} }]);
});

test('server autopilot keeps commit preparation and commit mutation behind advertised actions', async () => {
  const session = autonomySession({
    mode: 'guarded',
    attention: 'commit',
    privateChanges: {
      applied: { paths: ['src/a.js'], changedPaths: ['src/a.js'] },
      llm: { commitMessage: 'Update fixture behavior' },
    },
  });
  const gate = nextWorkflowAutonomyGate(session);
  const result = await decideWorkflowAutonomy({
    session,
    gate,
    requestDecision: async () => acceptedDecision({
      gate: 'result-commit',
      action: 'create-new',
      targetId: 'llm',
      summary: 'Create the configured result commit.',
    }),
  });
  assert.deepEqual(result.actions, [
    { actionId: 'prepare-commit', input: {} },
    { actionId: 'commit', input: { message: 'Update fixture behavior' } },
  ]);
});

test('server autopilot preserves staged user work and can checkpoint eligible unstaged work', async () => {
  const guardedStaged = autonomySession({
    mode: 'guarded',
    attention: 'plan',
    privateChanges: {
      plan: {
        counts: { created: 0, updated: 1, deleted: 0 },
        created: [],
        updated: [{ path: 'src/a.js' }],
        deleted: [],
        gitStatus: {
          staged: [{ path: 'unrelated.js' }],
          unstaged: [],
          conflicted: [],
        },
      },
    },
  });
  assert.equal(nextWorkflowAutonomyGate(guardedStaged), null);

  const fullUnstaged = autonomySession({
    mode: 'full',
    attention: 'plan',
    privateChanges: {
      plan: {
        counts: { created: 0, updated: 1, deleted: 0 },
        created: [],
        updated: [{ path: 'src/a.js' }],
        deleted: [],
        gitStatus: {
          staged: [],
          unstaged: [{ path: 'local-only.js' }],
          conflicted: [],
        },
      },
    },
  });
  const gate = nextWorkflowAutonomyGate(fullUnstaged);
  assert.equal(gate.gate, 'local-work');
  const result = await decideWorkflowAutonomy({
    session: fullUnstaged,
    gate,
    requestDecision: async () => acceptedDecision({
      gate: 'local-work',
      action: 'create-checkpoint',
      summary: 'Protect the current unstaged work before applying.',
    }),
  });
  assert.deepEqual(result.actions, [{ actionId: 'create-checkpoint', input: {} }]);
  const next = appendWorkflowAutonomyDecision(fullUnstaged.executionManifest, result);
  assert.equal(next.autonomyCheckpointPending, true);
});

test('only full server autopilot may select an eligible unpublished commit rewrite', async () => {
  const rewriteCandidates = [{
    id: 'amend-head',
    kind: 'amend',
    revision: 'abc123',
    runIds: ['previous-run'],
  }];
  const full = autonomySession({
    mode: 'full',
    attention: 'commit',
    privateChanges: {
      applied: { paths: ['src/a.js'], changedPaths: ['src/a.js'] },
      llm: { commitMessage: 'Update fixture behavior' },
      commitRewriteCandidates: rewriteCandidates,
    },
  });
  const fullGate = nextWorkflowAutonomyGate(full);
  assert.equal(fullGate.allowedActions.includes('amend-head'), true);
  const result = await decideWorkflowAutonomy({
    session: full,
    gate: fullGate,
    requestDecision: async () => acceptedDecision({
      gate: 'result-commit',
      action: 'amend-head',
      targetId: 'amend-head',
      summary: 'Amend the eligible unpublished Zipflow commit.',
    }),
  });
  assert.deepEqual(result.actions, [{
    actionId: 'amend-commit',
    input: {
      targetId: 'amend-head',
      message: 'Update fixture behavior',
    },
  }]);

  const guarded = autonomySession({
    mode: 'guarded',
    attention: 'commit',
    privateChanges: {
      applied: { paths: ['src/a.js'], changedPaths: ['src/a.js'] },
      commitRewriteCandidates: rewriteCandidates,
    },
  });
  assert.equal(nextWorkflowAutonomyGate(guarded).allowedActions.includes('amend-head'), false);
});

function autonomySession({
  mode,
  attention,
  privateChanges = {},
}) {
  const capabilities = mode === 'full'
    ? {
        decidePlanApplication: true,
        decideConflicts: true,
        decideFailedChecks: true,
        decideResultCommit: true,
        decideDeployment: true,
        allowCommitAfterFailedChecks: true,
      }
    : {
        decidePlanApplication: true,
        decideConflicts: false,
        decideFailedChecks: true,
        decideResultCommit: true,
        decideDeployment: true,
        allowCommitAfterFailedChecks: false,
      };
  return {
    revision: 7,
    binding: { projectId: 'project-1', projectPath: '/private/project', workflowRevision: 3 },
    run: {
      runId: 'run-1',
      kind: 'archive',
      status: 'waiting_action',
      operationId: null,
    },
    publicSummary: {
      run: {
        id: 'run-1',
        status: 'waiting_action',
        attention,
        backupAvailable: true,
      },
    },
    executionManifest: {
      version: 1,
      workflow: {
        autonomy: {
          mode,
          profileVersion: 1,
          fullWarningAcknowledgedVersion: 1,
          maxCheckRetries: 1,
          maxDeployRetries: 1,
          capabilities,
        },
        git: { resultCommit: 'ask' },
        deploy: { policy: 'disabled', commandText: '', cwd: '.' },
      },
      settings: {
        llmProvider: 'lmstudio',
        llmModel: 'fixture-model',
      },
      plan: {
        counts: { created: 0, updated: 1, deleted: 0 },
        created: [],
        updated: [{ path: 'src/a.js' }],
        deleted: [],
      },
      created: [],
      updated: [{ path: 'src/a.js' }],
      deleted: [],
      conflicts: [],
      decisions: [{ path: 'src/a.js', decision: 'archive' }],
      safety: { warnings: [], acknowledged: true, llm: null },
      llmReviewStatus: 'completed',
      autonomy: {
        mode,
        paused: false,
        decisions: [],
        fallbackCount: 0,
        checkRetries: 0,
        deployRetries: 0,
      },
      autonomyDecisions: [],
      ...structuredClone(privateChanges),
    },
  };
}

function acceptedDecision({ gate, action, targetId = null, summary }) {
  return {
    schemaVersion: 1,
    gate,
    action,
    targetId,
    confidence: 0.95,
    effectiveConfidence: 0.87,
    summary,
    evidence: ['Deterministic plan is available.'],
    risks: [],
    conditions: [],
    accepted: true,
    stateHash: 'state-hash',
    repaired: false,
    provider: 'lmstudio',
    model: 'fixture-model',
  };
}
