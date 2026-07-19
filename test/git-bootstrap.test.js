import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { discoverProject } from '../src/project/detect.js';
import { addRecommendedGitignore } from '../src/git/ignore.js';
import { createInitialCommit, initializeRepository, listTrackedFiles, runGit } from '../src/git/repository.js';
import { tempDir, writeFiles } from '../test-support/helpers.js';

test('Git bootstrap creates recommended ignore rules and a clean first commit', async () => {
  const root = await tempDir('zipflow-git-bootstrap-');
  await writeFiles(root, {
    'package.json': '{"name":"fixture"}\n',
    'src/index.js': 'export const value = 1;\n',
    'node_modules/cache.txt': 'ignored\n',
    '.DS_Store': 'ignored\n',
    '.zipflow/commit-message.txt': 'must stay local metadata\n',
  });
  let project = await discoverProject(root);
  assert.equal(project.git, false);

  const initialized = await initializeRepository(root);
  assert.equal(initialized.ok, true);
  await runGit(root, ['config', 'user.email', 'zipflow@test.local']);
  await runGit(root, ['config', 'user.name', 'Zipflow Tests']);
  project = await discoverProject(root);

  const ignoreResult = await addRecommendedGitignore(project);
  assert.equal(ignoreResult.changed, true);
  const ignoreText = await readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignoreText, /node_modules\//);
  assert.match(ignoreText, /\.DS_Store/);
  assert.match(ignoreText, /\.idea\//);
  assert.match(ignoreText, /\.zipflow\//);

  const commit = await createInitialCommit(root, 'Initial project baseline');
  assert.equal(commit.ok, true);
  const tracked = await listTrackedFiles(root);
  assert.deepEqual(tracked, ['.gitignore', 'package.json', 'src/index.js']);
});

test('first commit excludes Zipflow metadata and other ignored files', async () => {
  const root = await tempDir('zipflow-first-commit-ignore-');
  await writeFiles(root, {
    '.gitignore': '.zipflow/\ncache/\n',
    '.zipflow/commit-message.txt': 'metadata\n',
    'cache/state.bin': 'cache\n',
    'src/index.js': 'export {};\n',
  });
  const initialized = await initializeRepository(root);
  assert.equal(initialized.ok, true);
  await runGit(root, ['config', 'user.email', 'zipflow@test.local']);
  await runGit(root, ['config', 'user.name', 'Zipflow Tests']);

  const commit = await createInitialCommit(root, 'Initial baseline');
  const tracked = await listTrackedFiles(root);

  assert.equal(commit.ok, true);
  assert.deepEqual(tracked, ['.gitignore', 'src/index.js']);
});

test('first commit can create a baseline containing only gitignore', async () => {
  const root = await tempDir('zipflow-empty-first-commit-');
  await writeFiles(root, {
    '.gitignore': '*\n!.gitignore\n',
  });
  const initialized = await initializeRepository(root);
  assert.equal(initialized.ok, true);
  await runGit(root, ['config', 'user.email', 'zipflow@test.local']);
  await runGit(root, ['config', 'user.name', 'Zipflow Tests']);

  const commit = await createInitialCommit(root, 'Initial baseline');

  assert.equal(commit.ok, true);
  assert.deepEqual(commit.paths, ['.gitignore']);
});
