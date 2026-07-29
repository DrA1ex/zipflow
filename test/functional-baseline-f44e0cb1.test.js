import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { ClientBackedZipflowController } from '../src/standalone/client-controller.js';
import { createStandaloneController } from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(await readFile(
  path.join(root, 'test/fixtures/functional-baseline-f44e0cb1.json'),
  'utf8',
));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

test('f44e0cb1 functional baseline remains explicit, complete, and executable', async () => {
  assert.equal(baseline.source.commit, 'f44e0cb127437ea6ce3e4c7773ccf553673d74dc');
  assert.equal(baseline.source.packageVersion, '1.8.3');
  assert.ok(baseline.capabilities.length >= 15);
  assert.equal(new Set(baseline.capabilities.map(({ id }) => id)).size, baseline.capabilities.length);
  for (const capability of baseline.capabilities) {
    assert.match(capability.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(capability.tests.length > 0, `${capability.id} has no regression owner`);
    for (const filename of capability.tests) {
      await access(path.join(root, 'test', filename));
    }
  }
  assert.equal(packageJson.scripts.test, 'ZIPFLOW_TEST_LOCALE=en node --test');
  assert.equal(
    packageJson.scripts['test:functional-baseline'],
    'ZIPFLOW_TEST_LOCALE=en node --test test/functional-baseline-f44e0cb1.test.js',
  );
});

test('direct implementation cannot be removed before client-backed f44e0cb1 parity is complete', () => {
  const direct = createStandaloneController(createInitialState(), { directMode: true });
  const clientBacked = createStandaloneController(createInitialState());
  assert.ok(clientBacked instanceof ClientBackedZipflowController);
  if (!baseline.clientBackedParityComplete) {
    assert.ok(direct instanceof ZipflowController);
    assert.notEqual(direct.constructor, clientBacked.constructor);
  }
});
