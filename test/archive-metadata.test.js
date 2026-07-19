import test from 'node:test';
import assert from 'node:assert/strict';
import { readArchiveMetadata } from '../src/archive/metadata.js';
import { buildUpdatePlan } from '../src/plan/build.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { discoverProject } from '../src/project/detect.js';
import { extractedFixture, initGit, tempDir, writeFiles } from '../test-support/helpers.js';

test('reads a commit message file from the archive without applying it to the project', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'package.json': '{"name":"fixture"}\n' });
  await initGit(root);
  const project = await discoverProject(root);
  const workflow = createRecommendedWorkflow(project);
  const extracted = await extractedFixture(root, {
    '.commit_message.txt': 'Implement archive metadata support\n\nKeep the body.\n',
    'src/new.js': 'export const value = 1;\n',
  });

  const metadata = await readArchiveMetadata(extracted);
  const plan = await buildUpdatePlan({ project, workflow, extracted });

  assert.equal(metadata.commitMessage, 'Implement archive metadata support\n\nKeep the body.');
  assert.equal(metadata.commitMessageSource, '.commit_message.txt');
  assert.deepEqual(plan.created.map((item) => item.path), ['src/new.js']);
});

test('uses the documented priority when several commit message files exist', async () => {
  const root = await tempDir();
  const extracted = await extractedFixture(root, {
    'COMMIT_MESSAGE.txt': 'lower priority\n',
    '.commit_message': 'legacy message\n',
    '.zipflow/commit-message.txt': 'preferred message\n',
  });

  const metadata = await readArchiveMetadata(extracted);

  assert.equal(metadata.commitMessage, 'preferred message');
  assert.equal(metadata.commitMessageSource, '.zipflow/commit-message.txt');
});
