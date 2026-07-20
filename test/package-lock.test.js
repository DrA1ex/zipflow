import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

test('package lock keeps public npm tarball URLs', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const resolved = Object.values(lock.packages ?? {})
    .map((entry) => entry?.resolved)
    .filter(Boolean);

  assert.ok(resolved.length > 0);
  assert.equal(resolved.every((url) => url.startsWith(PUBLIC_REGISTRY)), true);
  assert.equal(resolved.some((url) => /internal|private|artifactory/i.test(url)), false);
});
