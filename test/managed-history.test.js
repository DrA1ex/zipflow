import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildUpdatePlan } from '../src/plan/build.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { discoverProject } from '../src/project/detect.js';
import { loadManagedHistory, resetManagedHistory, updateManagedHistory } from '../src/history/managed.js';
import { extractedFixture, tempDir, writeFiles } from '../test-support/helpers.js';

test('managed-history snapshot deletes only paths previously created or updated by Zipflow', async () => {
  const home = await tempDir('zipflow-managed-home-');
  const root = await tempDir('zipflow-managed-project-');
  process.env.ZIPFLOW_HOME = home;
  try {
    await writeFiles(root, {
      'package.json': '{"name":"fixture"}\n',
      'src/managed.js': 'managed\n',
      'src/local.js': 'local\n',
    });
    const project = await discoverProject(root);
    const workflow = createRecommendedWorkflow(project);
    workflow.archive.mode = 'snapshot';
    workflow.deletion.scope = 'managed-history';
    await updateManagedHistory(root, [{ kind: 'updated', path: 'src/managed.js' }]);
    const extracted = await extractedFixture(root, {
      'package.json': await readFile(path.join(root, 'package.json'), 'utf8'),
    });

    const plan = await buildUpdatePlan({ project, workflow, extracted });

    assert.deepEqual(plan.deleted.map((item) => item.path), ['src/managed.js']);
    assert.equal(plan.preserved.some((item) => item.path === 'src/local.js'), true);
    const reset = await resetManagedHistory(root);
    assert.equal(reset.removed, 1);
    assert.deepEqual((await loadManagedHistory(root)).paths, []);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});
