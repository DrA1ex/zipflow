import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import {
  canonicalPath,
  completePath,
  displayPath,
  expandHome,
  parseEnteredPath,
  sameCanonicalPath,
} from '../src/utils/paths.js';
import { tempDir } from '../test-support/helpers.js';

test('canonicalPath resolves filesystem aliases to one stable path', async () => {
  const parent = await tempDir('zipflow-path-alias-');
  const real = path.join(parent, 'real-project');
  const alias = path.join(parent, 'project-link');
  await mkdir(real);
  await symlink(real, alias, 'dir');

  assert.equal(await canonicalPath(alias), await canonicalPath(real));
  assert.equal(await sameCanonicalPath(alias, real), true);
});

test('canonicalPath normalizes relative input before resolving it', async () => {
  const root = await tempDir('zipflow-path-relative-');
  await mkdir(path.join(root, 'nested'));

  const result = await canonicalPath(path.join(root, 'nested', '..'));

  assert.equal(result, root);
});

test('parseEnteredPath accepts quoted and shell-escaped paths', async () => {
  const root = await tempDir('zipflow-path-entry-');
  const expected = path.join(root, 'folder with space');

  assert.equal(parseEnteredPath('"folder with space"', root), expected);
  assert.equal(parseEnteredPath('folder\\ with\\ space', root), expected);
});

test('expandHome expands only a leading home marker', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/project'), path.join(os.homedir(), 'project'));
  assert.equal(expandHome('project/~'), 'project/~');
});

test('displayPath collapses paths inside the current home directory', () => {
  assert.equal(displayPath(os.homedir()), '~');
  assert.equal(displayPath(path.join(os.homedir(), 'dev', 'app')), path.join('~', 'dev', 'app'));
});

test('completePath filters directories and preserves a common prefix', async () => {
  const root = await tempDir('zipflow-path-complete-');
  await mkdir(path.join(root, 'alpha-one'));
  await mkdir(path.join(root, 'alpha-two'));
  await writeFile(path.join(root, 'alpha-file.zip'), 'zip');

  const result = await completePath(path.join(root, 'alpha-'), { directoriesOnly: true });

  assert.equal(result.value, path.join(root, 'alpha-'));
  assert.deepEqual(result.matches.map((item) => path.basename(item)).sort(), ['alpha-one', 'alpha-two']);
});

test('completePath completes a single matching archive file', async () => {
  const root = await tempDir('zipflow-path-extension-');
  await writeFile(path.join(root, 'update.zip'), 'zip');
  await writeFile(path.join(root, 'update.txt'), 'text');

  const result = await completePath(path.join(root, 'up'), { extension: '.zip' });

  assert.equal(result.value, path.join(root, 'update.zip'));
  assert.equal(result.matches.length, 1);
});

test('suggestPathEntries returns live directory and ZIP choices without hiding dot-paths', async () => {
  const { suggestPathEntries } = await import('../src/utils/paths.js');
  const root = await tempDir('zipflow-path-suggestions-');
  await mkdir(path.join(root, '.archives'));
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'first.zip'), 'zip');
  await writeFile(path.join(root, 'ignored.txt'), 'text');

  const result = await suggestPathEntries(`${root}${path.sep}`, { extension: '.zip' });

  assert.deepEqual(result.map((item) => item.label), ['.archives/', 'nested/', 'first.zip']);
  assert.equal(result.find((item) => item.label === 'first.zip').submit, true);
  assert.equal(result.find((item) => item.label === 'nested/').submit, false);
});

test('directory suggestions include an explicit action for choosing the current directory', async () => {
  const { suggestPathEntries } = await import('../src/utils/paths.js');
  const root = await tempDir('zipflow-path-current-');
  await mkdir(path.join(root, 'child'));

  const result = await suggestPathEntries(root, { directoriesOnly: true, includeCurrentDirectory: true });

  assert.equal(result[0].label, 'Use this directory');
  assert.equal(result[0].submit, true);
  assert.ok(result.some((item) => item.label === 'child/'));
});

test('does not suggest an exact file path when there is nothing left to complete', async () => {
  const { suggestPathEntries } = await import('../src/utils/paths.js');
  const root = await tempDir('zipflow-path-exact-file-');
  const archive = path.join(root, 'release.zip');
  await writeFile(archive, 'zip');

  const result = await suggestPathEntries(archive, { extension: '.zip' });

  assert.deepEqual(result, []);
});
