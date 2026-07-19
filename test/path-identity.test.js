import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { acquireProjectLock } from '../src/apply/lock.js';
import { loadWorkflow, saveWorkflow, workflowPathForProject } from '../src/workflow/store.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { discoverProject } from '../src/project/detect.js';
import { tempDir, writeFiles } from '../test-support/helpers.js';

test('workflow storage uses the same file for real and aliased project paths', async () => {
  const home = await tempDir('zipflow-path-home-');
  const parent = await tempDir('zipflow-path-project-');
  const real = path.join(parent, 'real');
  const alias = path.join(parent, 'alias');
  await mkdir(real);
  await symlink(real, alias, 'dir');
  await writeFiles(real, { 'package.json': '{"name":"alias-project"}\n' });
  process.env.ZIPFLOW_HOME = home;
  try {
    const project = await discoverProject(alias);
    await saveWorkflow(createRecommendedWorkflow(project));

    assert.equal(await workflowPathForProject(alias), await workflowPathForProject(real));
    const loaded = await loadWorkflow(real);
    assert.equal(loaded.name, 'alias-project');
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

test('project locks cannot be bypassed through a symlink alias', async () => {
  const home = await tempDir('zipflow-lock-home-');
  const parent = await tempDir('zipflow-lock-project-');
  const real = path.join(parent, 'real');
  const alias = path.join(parent, 'alias');
  await mkdir(real);
  await symlink(real, alias, 'dir');
  process.env.ZIPFLOW_HOME = home;
  let lock;
  try {
    lock = await acquireProjectLock(alias, 'run-one');
    await assert.rejects(
      acquireProjectLock(real, 'run-two'),
      /Another Zipflow run is active.*run-one/,
    );
    const stored = JSON.parse(await readFile(lock.path, 'utf8'));
    assert.equal(stored.projectPath, real);
  } finally {
    await lock?.release();
    delete process.env.ZIPFLOW_HOME;
  }
});
