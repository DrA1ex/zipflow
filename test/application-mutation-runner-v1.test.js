import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { buildUpdatePlan } from '../src/plan/build.js';
import { createPlanDecisions, serializePlanSelections } from '../src/plan/selection.js';
import {
  applyExecutablePlan,
  inspectExecutableRollback,
  rollbackExecutableRun,
} from '../src/application/project-mutation-runner.js';
import {
  commitAppliedRun,
  nextPostCheckAttention,
  nextPostCommitAttention,
  runConfiguredChecks,
  runConfiguredDeployment,
} from '../src/application/post-apply-runner.js';
import { extractedFixture, initGit } from '../test-support/helpers.js';
import { normalizeWorkflow } from '../src/workflow/defaults.js';

test('headless project mutation runner applies and rolls back the executable manifest', async (t) => {
  const fixture = await mutationFixture(t);
  const extracted = await extractedFixture(fixture.root, {
    'file.txt': 'after\n',
    'created.txt': 'created\n',
  });
  const plan = await buildUpdatePlan({
    project: fixture.project,
    workflow: fixture.workflow,
    extracted,
  });
  const executable = executionManifest(fixture, plan, extracted);
  const progress = [];
  const result = await applyExecutablePlan({
    runId: fixture.runId,
    projectPath: fixture.project.root,
    executable,
    onProgress: (event) => progress.push(event.stage),
  });
  assert.equal(await readFile(path.join(fixture.project.root, 'file.txt'), 'utf8'), 'after\n');
  assert.equal(await readFile(path.join(fixture.project.root, 'created.txt'), 'utf8'), 'created\n');
  assert.deepEqual(result.applied.counts, { created: 1, updated: 1, deleted: 0 });
  assert.equal(result.applied.backupAvailable, true);
  assert.ok(progress.includes('backup'));
  assert.equal((await inspectExecutableRollback({
    runId: fixture.runId,
    projectPath: fixture.project.root,
    executable,
  })).available, true);

  const rollback = await rollbackExecutableRun({
    runId: fixture.runId,
    projectPath: fixture.project.root,
    executable,
    managedHistory: result.managedHistory,
  });
  assert.equal(rollback.restored, 2);
  assert.equal(await readFile(path.join(fixture.project.root, 'file.txt'), 'utf8'), 'before\n');
  await assert.rejects(readFile(path.join(fixture.project.root, 'created.txt')), { code: 'ENOENT' });
});

test('configured checks accept only selected IDs and expose bounded semantic progress', async (t) => {
  const fixture = await mutationFixture(t);
  const workflow = normalizeWorkflow({
    ...fixture.workflow,
    checks: [
      {
        id: 'node-ok',
        name: 'Node fixture',
        kind: 'command',
        command: [process.execPath, '-e', 'process.stdout.write("ok")'],
        selected: true,
        required: true,
        cwd: '.',
      },
      {
        id: 'not-selected',
        name: 'Disabled',
        kind: 'command',
        command: [process.execPath, '-e', 'process.exit(9)'],
        selected: false,
        required: true,
        cwd: '.',
      },
    ],
  });
  const progress = [];
  const result = await runConfiguredChecks({
    workflow,
    projectPath: fixture.project.root,
    changedPaths: ['file.txt'],
    checkIds: ['node-ok'],
    onProgress: (event) => progress.push(event),
  });
  assert.equal(result.checks.ok, true);
  assert.deepEqual(result.selectedCheckIds, ['node-ok']);
  assert.equal(result.output, 'ok');
  assert.ok(progress.some(({ type }) => type === 'finished'));
  await assert.rejects(
    runConfiguredChecks({
      workflow,
      projectPath: fixture.project.root,
      checkIds: ['not-selected'],
    }),
    (error) => error?.code === 'ACTION_INPUT_INVALID'
      && error.details.unknownCheckIds[0] === 'not-selected',
  );
});

test('headless commit and deployment use only configured workflow commands', async (t) => {
  const fixture = await mutationFixture(t, { git: true });
  await writeFile(path.join(fixture.project.root, 'file.txt'), 'committed change\n');
  const committed = await commitAppliedRun({
    workflow: fixture.workflow,
    projectPath: fixture.project.root,
    appliedPaths: ['file.txt'],
    message: 'Apply server workflow',
  });
  assert.match(committed.revision, /^[a-f0-9]+$/);
  assert.equal(committed.message, 'Apply server workflow');

  const workflow = normalizeWorkflow({
    ...fixture.workflow,
    deploy: {
      policy: 'ask',
      commandText: `"${process.execPath}" -e "process.stdout.write('deployed')"`,
      cwd: '.',
      timeoutMs: 10_000,
    },
  });
  const deployed = await runConfiguredDeployment({
    workflow,
    projectPath: fixture.project.root,
  });
  assert.equal(deployed.ok, true);
  assert.equal(deployed.stdout, 'deployed');
  assert.equal(nextPostCheckAttention({
    workflow,
    applied: { paths: ['file.txt'] },
    checks: { ok: true },
  }), 'commit');
  assert.equal(nextPostCommitAttention(workflow), 'deploy');

  await assert.rejects(
    runConfiguredDeployment({
      workflow: normalizeWorkflow({
        ...workflow,
        deploy: { policy: 'disabled', commandText: '', cwd: '.' },
      }),
      projectPath: fixture.project.root,
    }),
    (error) => error?.code === 'ACTION_NOT_AVAILABLE',
  );
});

async function mutationFixture(t, { git = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-mutation-runner-'));
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'file.txt'), 'before\n');
  if (git) await initGit(projectRoot);
  const previousHome = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const workflow = normalizeWorkflow({
    version: 9,
    name: 'fixture',
    projectPath: projectRoot,
    checks: [],
    exclude: [],
    archive: { mode: 'overlay' },
    deletion: { scope: 'tracked-only' },
    policy: { conflictPolicy: 'ask', confirmPlan: true },
    git: { checkpoint: 'never', resultCommit: git ? 'ask' : 'never', hooks: 'disabled' },
    deploy: { policy: 'disabled', commandText: '', cwd: '.' },
  });
  return {
    root,
    home,
    runId: `run_mutation_${path.basename(root).replaceAll('-', '_')}`,
    project: {
      root: projectRoot,
      name: 'fixture',
      git: git ? { root: projectRoot } : null,
    },
    workflow,
  };
}

function executionManifest(fixture, plan, extracted) {
  const decisions = createPlanDecisions(plan);
  for (const conflict of plan.conflicts) decisions.set(conflict.path, 'archive');
  return {
    version: 1,
    binding: {
      runId: fixture.runId,
      projectPath: fixture.project.root,
      workflowRevision: 1,
      blob: {
        blobId: `sha256:${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        size: 1,
      },
    },
    extracted,
    plan,
    decisions: serializePlanSelections(plan, decisions),
  };
}
