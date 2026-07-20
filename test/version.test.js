import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ZIPFLOW_VERSION } from '../src/version.js';

test('displayed application version matches package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(ZIPFLOW_VERSION, pkg.version);
});
