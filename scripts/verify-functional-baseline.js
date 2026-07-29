#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(
  root,
  'test',
  'fixtures',
  'functional-baseline-f44e0cb1.json',
);
const baseline = JSON.parse(readFileSync(manifestPath, 'utf8'));
const tests = new Set(['functional-baseline-f44e0cb1.test.js']);

for (const capability of baseline.capabilities ?? []) {
  for (const filename of capability.tests ?? []) tests.add(filename);
  for (const filename of capability.clientBackedTests ?? []) tests.add(filename);
}

const result = spawnSync(process.execPath, [
  '--test',
  ...[...tests].sort().map((filename) => path.join('test', filename)),
], {
  cwd: root,
  env: {
    ...process.env,
    ZIPFLOW_TEST_LOCALE: 'en',
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
