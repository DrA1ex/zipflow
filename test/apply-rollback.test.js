import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { applyUpdatePlan } from '../src/apply/apply.js';
import { rollbackRun } from '../src/apply/rollback.js';
import { buildUpdatePlan } from '../src/plan/build.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { discoverProject } from '../src/project/detect.js';
import { tempDir, writeFiles, initGit, extractedFixture } from '../test-support/helpers.js';
import { hashFile } from '../src/utils/hash.js';

test('rollback restores the exact pre-run dirty content and removes created files', async () => {
  const home = await tempDir('zipflow-home-');
  process.env.ZIPFLOW_HOME = home;
  const root = await tempDir();
  await writeFiles(root, {
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'src/a.js': 'committed\n',
  });
  await initGit(root);
  await writeFile(path.join(root, 'src/a.js'), 'local dirty content\n');
  const project = await discoverProject(root);
  const workflow = createRecommendedWorkflow(project);
  const extracted = await extractedFixture(root, {
    'src/a.js': 'archive content\n',
    'src/new.js': 'new file\n',
  });
  const plan = await buildUpdatePlan({ project, workflow, extracted });
  const decisions = new Map([['src/a.js', 'archive']]);

  await applyUpdatePlan({ runId: 'zf-test-rollback', projectPath: root, plan, decisions });
  assert.equal(await readFile(path.join(root, 'src/a.js'), 'utf8'), 'archive content\n');
  assert.equal(await readFile(path.join(root, 'src/new.js'), 'utf8'), 'new file\n');

  await rollbackRun('zf-test-rollback');

  assert.equal(await readFile(path.join(root, 'src/a.js'), 'utf8'), 'local dirty content\n');
  await assert.rejects(readFile(path.join(root, 'src/new.js'), 'utf8'), { code: 'ENOENT' });
});

test('apply aborts when a project file changes after the plan was built', async () => {
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-home-');
  const root = await tempDir();
  await writeFiles(root, {
    'package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'src/a.js': 'before\n',
  });
  await initGit(root);
  const project = await discoverProject(root);
  const workflow = createRecommendedWorkflow(project);
  const extracted = await extractedFixture(root, { 'src/a.js': 'archive\n' });
  const plan = await buildUpdatePlan({ project, workflow, extracted });
  await writeFile(path.join(root, 'src/a.js'), 'edited after review\n');

  await assert.rejects(
    applyUpdatePlan({ runId: 'zf-test-race', projectPath: root, plan }),
    /changed after the plan was shown/,
  );
  assert.equal(await readFile(path.join(root, 'src/a.js'), 'utf8'), 'edited after review\n');
});

test('partial application failures restore every touched file automatically', async () => {
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-home-');
  const root = await tempDir();
  await writeFiles(root, { 'delete.txt': 'keep me\n', 'update.txt': 'old\n' });
  const missingSource = path.join(root, 'missing-source.txt');
  const plan = {
    created: [],
    updated: [{
      kind: 'updated', path: 'update.txt', currentPath: path.join(root, 'update.txt'), sourcePath: missingSource,
      beforeHash: await hashFile(path.join(root, 'update.txt')), afterHash: 'missing', mode: 0o644,
    }],
    deleted: [{
      kind: 'deleted', path: 'delete.txt', currentPath: path.join(root, 'delete.txt'),
      beforeHash: await hashFile(path.join(root, 'delete.txt')), afterHash: null, mode: 0o644,
    }],
    conflicts: [],
  };

  await assert.rejects(
    applyUpdatePlan({ runId: 'zf-test-atomic', projectPath: root, plan }),
    /all touched files were restored/,
  );
  assert.equal(await readFile(path.join(root, 'delete.txt'), 'utf8'), 'keep me\n');
  assert.equal(await readFile(path.join(root, 'update.txt'), 'utf8'), 'old\n');
});
