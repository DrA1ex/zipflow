import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { activateRun, inspectArchivePath } from '../src/app/run-flow.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { activeArchiveMode } from '../src/app/archive-interpretation.js';
import { cancelRun } from '../src/app/run-lifecycle.js';
import { createZip, initGit, tempDir, writeFiles } from '../test-support/helpers.js';

async function withHome(run) {
  const previous = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-interpretation-home-');
  try { await run(); } finally {
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
  }
}

test('a suspicious snapshot can be rebuilt as overlay and then restored as snapshot without changing the workflow', async () => withHome(async () => {
  const root = await tempDir('zipflow-interpretation-project-');
  await writeFiles(root, {
    'package.json': '{"name":"fixture"}\n',
    'src/app.js': 'old\n',
    'src/feature.js': 'feature\n',
    'test/app.test.js': 'test\n',
    'docs/guide.md': 'guide\n',
    'scripts/build.js': 'build\n',
  });
  await initGit(root);
  const archivePath = path.join(await tempDir('zipflow-interpretation-archive-'), 'patch.zip');
  await createZip(archivePath, {
    'package.json': '{"name":"fixture"}\n',
    'src/app.js': 'new\n',
  });

  const project = {
    root, name: 'fixture', git: true, checks: [], technologies: [], labels: [],
    projects: [{ path: '.', technologies: [], labels: [], selected: true }],
  };
  const workflow = createRecommendedWorkflow(project);
  workflow.archive.mode = 'snapshot';
  workflow.deletion.scope = 'tracked-only';
  workflow.policy.confirmPlan = true;
  const state = createInitialState();
  state.project = project;
  state.workflow = workflow;
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  await inspectArchivePath(controller, archivePath);
  assert.equal(state.screen, 'archive-safety');
  assert.equal(activeArchiveMode(state), 'snapshot');
  assert.equal(state.plan.deleted.length, 4);
  assert.ok(state.archiveSafety.warnings.some((warning) => warning.id === 'possible-patch-archive'));
  assert.ok(state.menuItems.some((item) => item.id === 'recheck-as-overlay'));
  assert.ok(state.menuItems.some((item) => item.id === 'review-deletion-intent'));

  await activateRun(controller, 'recheck-as-overlay');
  assert.equal(activeArchiveMode(state), 'overlay');
  assert.equal(state.workflow.archive.mode, 'snapshot');
  assert.equal(state.plan.deleted.length, 0);
  assert.equal(state.run.archiveInterpretation.mode, 'overlay');
  assert.ok(state.menuItems.some((item) => item.id === 'recheck-as-snapshot'));

  await activateRun(controller, 'recheck-as-snapshot');
  assert.equal(activeArchiveMode(state), 'snapshot');
  assert.equal(state.workflow.archive.mode, 'snapshot');
  assert.equal(state.plan.deleted.length, 4);
  assert.ok(state.archiveSafety.warnings.some((warning) => warning.id === 'possible-patch-archive'));

  await cancelRun(controller);
}));
