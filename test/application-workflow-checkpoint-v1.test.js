import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkflowCheckpoint,
  workflowCheckpointRequired,
} from '../src/application/workflow-checkpoint-runner.js';

test('server checkpoint preserves the index and may reuse the configured dirty-tree LLM message', async () => {
  const privateState = checkpointState();
  const phases = [];
  assert.equal(workflowCheckpointRequired(privateState), true);
  const checkpoint = await createWorkflowCheckpoint({
    runId: 'run-1',
    project: { root: '/private/project', name: 'Fixture' },
    privateState,
    onProgress: ({ phase }) => phases.push(phase),
    buildChangeSet: async () => ({
      entries: [{ path: 'src/local.js' }],
      plan: {
        counts: { created: 0, updated: 1, deleted: 0 },
        created: [],
        updated: [{ path: 'src/local.js' }],
        deleted: [],
      },
      patchContent: 'diff --git a/src/local.js b/src/local.js\n-old\n+new\n',
    }),
    generateDescription: async () => ({
      commitMessage: 'Checkpoint local fixture work',
    }),
    createRef: async (projectRoot, runId, options) => {
      assert.equal(projectRoot, '/private/project');
      assert.equal(runId, 'run-1');
      assert.equal(options.message, 'Checkpoint local fixture work');
      return {
        ok: true,
        revision: 'abc123',
        ref: 'refs/zipflow/checkpoints/run-1',
        paths: ['src/local.js'],
        untrackedPaths: ['local.txt'],
      };
    },
  });
  assert.equal(checkpoint.messageSource, 'llm');
  assert.equal(checkpoint.preservesIndex, true);
  assert.deepEqual(checkpoint.backupOnlyPaths, ['local.txt']);
  assert.deepEqual(phases, ['checkpoint_changes', 'checkpoint_message', 'checkpoint_git']);
});

test('checkpoint is required only when an archive conflict resolution replaces local work', () => {
  const state = checkpointState();
  state.decisions[0].decision = 'keep';
  assert.equal(workflowCheckpointRequired(state), false);
  state.decisions[0].decision = 'archive';
  state.checkpointResolution = 'skipped';
  assert.equal(workflowCheckpointRequired(state), false);
});

function checkpointState() {
  return {
    workflow: {
      git: { checkpoint: 'ask' },
    },
    settings: {
      llmProvider: 'lmstudio',
      llmModel: 'fixture-model',
      llmUseDirtyTreeCommitMessage: true,
    },
    plan: {
      gitStatus: { staged: [], unstaged: [{ path: 'src/local.js' }], conflicted: [] },
    },
    conflicts: [{ path: 'src/local.js' }],
    decisions: [{ path: 'src/local.js', decision: 'archive' }],
  };
}
