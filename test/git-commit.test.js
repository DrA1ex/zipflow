import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { createCommit, getGitStatus, runGit } from '../src/git/repository.js';
import { tempDir, writeFiles, initGit } from '../test-support/helpers.js';

test('result commits include only paths applied by the run', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'a.txt': 'a1\n', 'b.txt': 'b1\n' });
  await initGit(root);
  await writeFile(path.join(root, 'a.txt'), 'a2\n');
  await writeFile(path.join(root, 'b.txt'), 'b2\n');

  const result = await createCommit(root, ['a.txt'], 'Apply archive');

  assert.equal(result.ok, true);
  const names = await runGit(root, ['show', '--pretty=', '--name-only', 'HEAD']);
  assert.equal(names.stdout.trim(), 'a.txt');
  const status = await getGitStatus(root);
  assert.equal(status.byPath.has('b.txt'), true);
});

test('pre-existing staged changes block automatic commits without modifying the index', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'a.txt': 'a1\n', 'b.txt': 'b1\n' });
  await initGit(root);
  await writeFile(path.join(root, 'a.txt'), 'a2\n');
  await writeFile(path.join(root, 'b.txt'), 'b2\n');
  await runGit(root, ['add', 'b.txt']);

  const result = await createCommit(root, ['a.txt'], 'Apply archive');
  const status = await getGitStatus(root);

  assert.equal(result.ok, false);
  assert.match(result.reason, /staged changes/);
  assert.equal(status.byPath.get('b.txt').indexStatus, 'M');
  assert.equal(status.byPath.get('a.txt').worktreeStatus, 'M');
});


test('result commits silently exclude protected and untracked ignored paths', async () => {
  const root = await tempDir('zipflow-commit-filter-');
  await writeFiles(root, {
    '.gitignore': '.zipflow/\nignored.txt\n',
    'a.txt': 'a1\n',
  });
  await initGit(root);
  await writeFile(path.join(root, 'a.txt'), 'a2\n');
  await writeFiles(root, {
    '.zipflow/commit-message.txt': 'metadata\n',
    'ignored.txt': 'ignored\n',
  });

  const result = await createCommit(root, ['a.txt', '.zipflow/commit-message.txt', 'ignored.txt'], 'Apply archive');

  assert.equal(result.ok, true);
  assert.deepEqual(result.paths, ['a.txt']);
  assert.deepEqual(result.omittedPaths.sort(), ['.zipflow/commit-message.txt', 'ignored.txt']);
  const names = await runGit(root, ['show', '--pretty=', '--name-only', 'HEAD']);
  assert.equal(names.stdout.trim(), 'a.txt');
});

test('result commit records a deletion without staging unrelated changes', async () => {
  const root = await tempDir('zipflow-commit-delete-');
  await writeFiles(root, { 'remove.txt': 'old\n', 'keep.txt': 'one\n' });
  await initGit(root);
  await rm(path.join(root, 'remove.txt'));
  await writeFile(path.join(root, 'keep.txt'), 'two\n');

  const result = await createCommit(root, ['remove.txt'], 'Remove archived file');

  assert.equal(result.ok, true);
  const names = await runGit(root, ['show', '--pretty=', '--name-status', 'HEAD']);
  assert.match(names.stdout, /^D\s+remove\.txt/m);
  const status = await getGitStatus(root);
  assert.equal(status.byPath.get('keep.txt').worktreeStatus, 'M');
});

test('an ignored-only result commit leaves the Git index untouched', async () => {
  const root = await tempDir('zipflow-commit-ignored-only-');
  await writeFiles(root, { '.gitignore': 'ignored.txt\n', 'tracked.txt': 'one\n' });
  await initGit(root);
  await writeFiles(root, { 'ignored.txt': 'local\n' });

  const result = await createCommit(root, ['ignored.txt', '.zipflow/commit-message.txt'], 'Nothing to commit');
  const staged = await runGit(root, ['diff', '--cached', '--name-only']);

  assert.equal(result.ok, false);
  assert.match(result.reason, /no committable applied paths/i);
  assert.equal(staged.stdout.trim(), '');
});
