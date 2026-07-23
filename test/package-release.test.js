import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const readme = await readFile(path.join(root, 'README.md'), 'utf8');

test('npm release metadata declares a public executable package and a verification gate', async () => {
  assert.equal(packageJson.name, 'zipflow');
  assert.equal(packageJson.publishConfig?.access, 'public');
  assert.equal(packageJson.publishConfig?.registry, 'https://registry.npmjs.org/');
  assert.equal(packageJson.bin?.zipflow, './bin/zipflow.js');
  assert.match(packageJson.engines?.node ?? '', />=20/);
  assert.deepEqual(packageJson.os, ['darwin', 'linux']);
  assert.ok(packageJson.keywords.includes('terminal'));
  assert.ok(packageJson.keywords.includes('rollback'));
  assert.equal(packageJson.scripts?.prepublishOnly, 'npm run verify');
  assert.match(packageJson.scripts?.['release:check'] ?? '', /npm run verify/);
  assert.match(packageJson.scripts?.['release:check'] ?? '', /npm pack --dry-run/);
  assert.ok(packageJson.files.includes('docs'));

  const executable = await stat(path.join(root, 'bin/zipflow.js'));
  assert.notEqual(executable.mode & 0o111, 0);
});

test('package README stays concise and sends detailed guidance to docs', async () => {
  assert.ok(readme.split(/\r?\n/).length <= 140);
  assert.match(readme, /npm install --global zipflow/);
  assert.match(readme, /docs\/README\.md/);
  assert.doesNotMatch(readme, /^## Safety model$/m);
  assert.doesNotMatch(readme, /^## Decision modes and autopilot$/m);
  assert.doesNotMatch(readme, /^## Data and storage$/m);

  for (const file of [
    'docs/README.md',
    'docs/getting-started.md',
    'docs/safety.md',
    'docs/local-llm.md',
    'docs/settings-and-storage.md',
    'docs/development.md',
  ]) await access(path.join(root, file));
});
