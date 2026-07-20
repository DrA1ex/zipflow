import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { activatePostCheck } from '../src/app/run-postcheck.js';
import { activateRollback, showRunDetails } from '../src/app/run-rollback.js';
import { activateExport, beginCreateZip } from '../src/app/export-flow.js';
import { beginSetup, activateSetup } from '../src/app/setup-flow.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { saveWorkflow } from '../src/workflow/store.js';
import { tempDir, writeFiles } from '../test-support/helpers.js';

function projectFixture(root = '/tmp/fixture') {
  return {
    name: 'fixture', root, labels: ['Node.js'], technologies: [{ id: 'node' }],
    checks: [{ id: 'test', name: 'Unit tests', description: 'npm test', selected: true }], git: true,
  };
}


test('configured projects boot directly into archive waiting and Escape opens the compact project menu', { concurrency: false }, async () => {
  const root = await tempDir('zipflow-auto-wait-project-');
  const home = await tempDir('zipflow-auto-wait-home-');
  await writeFiles(root, { 'package.json': '{"name":"auto-wait"}\n' });
  const previousHome = process.env.ZIPFLOW_HOME;
  const previousCwd = process.cwd();
  process.env.ZIPFLOW_HOME = home;
  process.chdir(root);
  try {
    const project = projectFixture(root);
    project.name = 'auto-wait';
    await saveWorkflow(createRecommendedWorkflow(project));
    const state = createInitialState();
    const controller = new ZipflowController(state);

    await controller.boot();

    assert.equal(state.screen, 'archive-input');
    const detected = state.messages.find((message) => message.title === 'Project detected');
    assert.ok(detected);
    assert.ok(detected.lines.some((line) => /Archive: Overlay/.test(line)));
    const hint = state.messages.find((message) => message.title === 'Hint');
    assert.ok(hint);
    assert.match(hint.lines.join(' '), /press Esc/i);
    assert.equal(detected.lines.some((line) => /press Esc/i.test(line)), false);
    await controller.handleKey({ name: 'escape', printable: false });
    assert.equal(state.screen, 'home');
    assert.deepEqual(state.panelIntro, []);
    assert.ok(state.menuItems.some((item) => item.id === 'change-workflow'));
    assert.equal(state.menuItems.some((item) => item.id === 'fine-tune' || item.id === 'fresh-setup'), false);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
  }
});

test('Change workflow opens a section editor and returns after each isolated change', async () => {
  const state = createInitialState();
  state.project = projectFixture();
  state.workflow = createRecommendedWorkflow(state.project);
  const controller = new ZipflowController(state);

  await beginSetup(controller, { fresh: false });
  assert.equal(state.screen, 'setup-sections');
  assert.ok(state.menuItems.some((item) => item.id === 'section-checks'));
  assert.ok(state.menuItems.some((item) => item.id === 'section-review'));

  await activateSetup(controller, 'section-policy');
  assert.equal(state.screen, 'setup-policy');
  await activateSetup(controller, 'profile-trust');
  assert.equal(state.draft.policy.id, 'trust');
  await activateSetup(controller, 'policy-continue');

  assert.equal(state.screen, 'setup-sections');
  assert.equal(state.menuItems[state.selectedIndex].id, 'section-policy');
});

test('Finish keeps Zipflow waiting for the next archive', async () => {
  const state = createInitialState();
  state.project = projectFixture();
  state.workflow = createRecommendedWorkflow(state.project);
  state.screen = 'completed';
  const controller = new ZipflowController(state);

  await activatePostCheck(controller, 'home');

  assert.equal(state.screen, 'archive-input');
  assert.equal(state.editorContext.purpose, 'archive-path');
  assert.match(state.status, /Waiting for archive/i);
});


test('keeping an update after failed checks still offers a result commit and skips deployment', async () => {
  const state = createInitialState();
  state.project = projectFixture();
  state.workflow = createRecommendedWorkflow(state.project);
  state.workflow.git.resultCommit = 'ask';
  state.workflow.deploy = { policy: 'always', commandText: './scripts/deploy.sh', cwd: '.' };
  state.run = {
    id: 'failed-run', status: 'checks_failed',
    applied: { paths: ['src/index.js'], changedPaths: ['src/index.js'] },
    checks: { ok: false, passed: 0, failed: 1, results: [{ id: 'test', name: 'Unit tests', ok: false }] },
  };
  state.screen = 'check-failed';
  const controller = new ZipflowController(state);

  await activatePostCheck(controller, 'keep-changes');

  assert.equal(state.screen, 'commit');
  assert.equal(state.postCheckContinuation.status, 'completed_with_errors');
  assert.equal(state.postCheckContinuation.skipDeploy, true);
  assert.ok(state.menuItems.some((item) => item.id === 'create-commit'));
  assert.match(state.panelIntro.join(' '), /Required checks failed/);
});

test('run history exposes changed groups and stored file diffs', async () => {
  const root = await tempDir('zipflow-history-diff-');
  const patchPath = path.join(root, 'changes.patch');
  await writeFile(patchPath, [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '',
  ].join('\n'));
  const state = createInitialState();
  state.project = projectFixture(root);
  state.run = {
    id: 'run-1', status: 'completed', archivePath: '/tmp/update.zip', projectPath: root,
    plan: { counts: { created: 0, updated: 1, deleted: 0, unchanged: 0, skipped: 0, preserved: 0, conflicts: 0 }, created: [], updated: ['src/a.js'], deleted: [] },
    patch: { path: patchPath }, decisions: [],
  };
  state.runDetailsOrigin = 'history';
  const controller = new ZipflowController(state);

  showRunDetails(controller, state.run, { origin: 'history' });
  assert.ok(state.menuItems.some((item) => item.id === 'view-run-files'));
  assert.ok(state.menuItems.some((item) => item.id === 'view-run-diff'));

  await activateRollback(controller, 'view-run-files');
  assert.equal(state.screen, 'run-file-groups');
  await activateRollback(controller, 'run-group:updated');
  assert.equal(state.screen, 'run-file-list');
  await activateRollback(controller, `run-file:${encodeURIComponent('src/a.js')}`);
  assert.equal(state.screen, 'diff-view');
  assert.equal(state.diffView.diff.path, 'src/a.js');
  assert.equal(state.diffView.diff.rows.some((row) => row.type === 'remove' && row.oldText === 'old'), true);
});

test('complete historical diff opens a multi-file diff workspace', async () => {
  const root = await tempDir('zipflow-history-full-diff-');
  const patchPath = path.join(root, 'changes.patch');
  await writeFile(patchPath, 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n');
  const state = createInitialState();
  state.project = projectFixture(root);
  state.run = {
    id: 'run-2', status: 'completed', archivePath: '/tmp/update.zip', projectPath: root,
    plan: { counts: { created: 0, updated: 1, deleted: 0, unchanged: 0, skipped: 0, preserved: 0, conflicts: 0 }, created: [], updated: ['a.txt'], deleted: [] },
    patch: { path: patchPath }, decisions: [],
  };
  const controller = new ZipflowController(state);
  showRunDetails(controller, state.run, { origin: 'history' });

  await activateRollback(controller, 'view-run-diff');

  assert.equal(state.screen, 'diff-view');
  assert.equal(state.diffView.source, 'stored');
  assert.equal(state.diffView.files.length, 1);
  assert.equal(state.diffView.diff.path, 'a.txt');
  assert.equal(state.diffView.diff.rows.some((row) => row.type === 'add' && row.newText === 'new'), true);
});

test('ZIP file review groups directories and allows file and folder exclusion', async () => {
  const root = await tempDir('zipflow-export-review-');
  await writeFiles(root, {
    'README.md': 'root\n',
    'src/a.js': 'a\n',
    'src/b.js': 'b\n',
    'test/a.test.js': 'test\n',
  });
  const state = createInitialState();
  state.project = projectFixture(root);
  const controller = new ZipflowController(state);

  beginCreateZip(controller);
  await activateExport(controller, 'export-all');
  await activateExport(controller, 'export-review-files');

  const rootIndex = state.menuItems.findIndex((item) => item.id === `export-file:${encodeURIComponent('README.md')}`);
  const srcIndex = state.menuItems.findIndex((item) => item.id === `export-dir:${encodeURIComponent('src')}`);
  const srcFileIndex = state.menuItems.findIndex((item) => item.id === `export-file:${encodeURIComponent('src/a.js')}`);
  assert.ok(rootIndex >= 0 && rootIndex < srcIndex && srcIndex < srcFileIndex);

  await activateExport(controller, `export-dir:${encodeURIComponent('src')}`);
  assert.equal(state.exportDraft.selectedPaths.has('src/a.js'), false);
  assert.equal(state.menuItems.some((item) => item.id === `export-file:${encodeURIComponent('src/a.js')}`), false);
  const srcItem = state.menuItems.find((item) => item.id === `export-dir:${encodeURIComponent('src')}`);
  assert.match(srcItem.description, /hidden/i);

  await activateExport(controller, `export-file:${encodeURIComponent('README.md')}`);
  assert.equal(state.exportDraft.selectedPaths.has('README.md'), false);
  const rootItem = state.menuItems.find((item) => item.id === `export-file:${encodeURIComponent('README.md')}`);
  assert.match(rootItem.description, /Excluded from ZIP/i);
});


test('completed run offers only one action for waiting for the next archive', async () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], git: true };
  state.workflow = {
    archive: { mode: 'overlay' }, checks: [], policy: { label: 'Practical' },
    git: { resultCommit: 'never' }, deploy: { policy: 'disabled' },
  };
  state.run = {
    id: 'run-1', status: 'completed', applied: { paths: [], changedPaths: [] },
    plan: { counts: { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0, preserved: 0 } },
    checks: { passed: 0, failed: 0, results: [] },
  };
  const controller = new ZipflowController(state);
  const { showCompleted } = await import('../src/app/run-postcheck.js');

  showCompleted(controller);

  assert.equal(state.menuItems.filter((item) => /next archive|another archive/i.test(item.label)).length, 1);
  assert.equal(state.menuItems[0].label, 'Finish and wait for next archive');
});
