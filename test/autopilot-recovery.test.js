import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { offerInterruptedRunRecovery } from '../src/app/interrupted-run.js';
import { captureRunExecutionState, runExecutionStateValidator } from '../src/app/run-state-integrity.js';
import { markAutonomyDecision } from '../src/app/autonomy-flow.js';
import { getCommitRewriteCandidates } from '../src/git/repository.js';
import { loadRunRecord, saveRunRecord } from '../src/runs/store.js';
import { runProcess } from '../src/utils/process.js';
import { initGit, tempDir, writeFiles } from '../test-support/helpers.js';

function projectFixture(root, git = null) {
  return { root, name: path.basename(root), git, technologies: [], labels: [], checks: [], deploymentCandidates: [] };
}

function workflowFixture() {
  return {
    name: 'fixture', checks: [], autonomy: { mode: 'guarded' },
    git: { resultCommit: 'ask' }, deploy: { policy: 'disabled', commandText: '', cwd: '.' },
  };
}

test('startup recovery marks pending and executing autonomous decisions interrupted without replaying them', async () => {
  const home = await tempDir('zipflow-recovery-home-');
  const root = await tempDir('zipflow-recovery-project-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const run = await saveRunRecord({
      version: 9,
      id: 'run-interrupted-autopilot',
      projectPath: root,
      projectName: 'fixture',
      workflowName: 'fixture',
      archivePath: path.join(root, 'update.zip'),
      status: 'applying',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      applied: { paths: ['a.txt'], backupAvailable: true },
      decisions: [
        { id: 'decision-1', source: 'llm', gate: 'plan-application', action: 'apply', executionStatus: 'pending' },
        { id: 'decision-2', source: 'llm', gate: 'result-commit', action: 'create-new', executionStatus: 'executing' },
      ],
      autonomy: { mode: 'guarded', paused: false, decisions: ['decision-1', 'decision-2'], fallbackCount: 0 },
    });
    const state = createInitialState();
    state.project = projectFixture(root);
    state.workflow = workflowFixture();
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};

    assert.equal(await offerInterruptedRunRecovery(controller), undefined);
    assert.equal(state.screen, 'interrupted-run');
    assert.equal(state.run.status, 'interrupted');
    assert.deepEqual(state.run.decisions.map((item) => item.executionStatus), ['interrupted', 'interrupted']);
    assert.ok(state.run.decisions.every((item) => /not.*confirmed|stopped/i.test(item.executionError)));

    const stored = await loadRunRecord(run.id);
    assert.equal(stored.status, 'interrupted');
    assert.deepEqual(stored.decisions.map((item) => item.executionStatus), ['interrupted', 'interrupted']);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

test('autonomous decision execution records executing and executed audit states', async () => {
  const home = await tempDir('zipflow-decision-audit-home-');
  const root = await tempDir('zipflow-decision-audit-project-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const state = createInitialState();
    state.project = projectFixture(root);
    state.workflow = workflowFixture();
    state.run = await saveRunRecord({
      version: 9, id: 'run-decision-audit', projectPath: root, projectName: 'fixture', workflowName: 'fixture',
      archivePath: null, status: 'planned', createdAt: new Date().toISOString(), decisions: [{
        id: 'decision-1', source: 'llm', gate: 'deployment', action: 'skip', executionStatus: 'pending',
      }], autonomy: { mode: 'guarded', decisions: ['decision-1'], paused: false, fallbackCount: 0 },
    });
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};
    const decision = { record: { id: 'decision-1' } };

    await markAutonomyDecision(controller, decision, 'executing');
    assert.equal(state.run.decisions[0].executionStatus, 'executing');
    assert.ok(state.run.decisions[0].executionStartedAt);

    await markAutonomyDecision(controller, decision, 'executed', { result: 'deployment-skipped' });
    assert.equal(state.run.decisions[0].executionStatus, 'executed');
    assert.equal(state.run.decisions[0].executionResult, 'deployment-skipped');
    assert.ok(state.run.decisions[0].executedAt);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

test('execution-state validation rejects deployment after an applied file drifts', async () => {
  const root = await tempDir('zipflow-state-drift-');
  await writeFile(path.join(root, 'a.txt'), 'applied\n');
  const state = createInitialState();
  state.project = projectFixture(root);
  state.workflow = workflowFixture();
  state.run = { id: 'run-state-drift', status: 'checks_passed', applied: { paths: ['a.txt'] }, commit: null };
  state.plan = {
    created: [], deleted: [],
    updated: [{ kind: 'updated', path: 'a.txt' }],
  };
  const captured = await captureRunExecutionState(state);
  const validate = runExecutionStateValidator(state, captured);
  await writeFile(path.join(root, 'a.txt'), 'changed after decision\n');
  const result = await validate();
  assert.equal(result.ok, false);
  assert.notEqual(result.stateHash, captured.hash);
});

test('rewrite candidates include semantic run context and changed-path overlap for the LLM', async () => {
  const root = await tempDir('zipflow-rewrite-context-');
  await writeFiles(root, { 'a.txt': 'base\n', 'b.txt': 'base\n' });
  await initGit(root);
  await writeFile(path.join(root, 'a.txt'), 'feature update\n');
  await runProcess('git', ['add', 'a.txt'], { cwd: root });
  await runProcess('git', ['commit', '-qm', 'feat: continue feature'], { cwd: root });
  const revision = (await runProcess('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })).stdout.trim();
  const runs = [{
    id: 'run-feature', createdAt: new Date().toISOString(), archivePath: '/tmp/feature-update.zip',
    commit: { revision, message: 'feat: continue feature' },
    applied: { paths: ['a.txt'] },
    llm: { summary: ['Continue the same feature implementation.'] },
  }];
  const candidates = await getCommitRewriteCandidates(root, runs, { currentPaths: ['a.txt', 'b.txt'] });
  const amend = candidates.find((item) => item.kind === 'amend');
  assert.ok(amend);
  assert.equal(amend.commits[0].runId, 'run-feature');
  assert.equal(amend.commits[0].archiveName, 'feature-update.zip');
  assert.deepEqual(amend.commits[0].changedPaths, ['a.txt']);
  assert.deepEqual(amend.commits[0].overlappingPaths, ['a.txt']);
  assert.deepEqual(amend.commits[0].summary, ['Continue the same feature implementation.']);
});
