import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('package lock keeps public npm tarball URLs', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const resolved = Object.values(lock.packages ?? {})
    .map((entry) => entry?.resolved)
    .filter(Boolean);

  assert.ok(resolved.length > 0);
  assert.equal(resolved.every((url) => url.startsWith(PUBLIC_REGISTRY)), true);
  assert.equal(resolved.some((url) => /internal|private|artifactory/i.test(url)), false);
});


test('runtime dependencies and published shrinkwrap are exact and identical', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const shrinkwrap = JSON.parse(await readFile(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'));
  for (const manifest of [lock, shrinkwrap]) {
    assert.deepEqual(manifest.packages[''].os, packageJson.os);
  }
  for (const [name, version] of Object.entries(packageJson.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    assert.equal(lock.packages[''].dependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.equal(shrinkwrap.packages[''].dependencies[name], version);
    assert.equal(shrinkwrap.packages[`node_modules/${name}`].version, version);
  }
  assert.deepEqual(shrinkwrap, lock);
  const resolved = Object.values(shrinkwrap.packages ?? {}).map((entry) => entry?.resolved).filter(Boolean);
  assert.equal(resolved.every((url) => url.startsWith(PUBLIC_REGISTRY)), true);
});
