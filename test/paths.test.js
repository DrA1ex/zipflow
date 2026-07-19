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
