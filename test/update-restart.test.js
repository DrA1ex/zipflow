import assert from 'node:assert/strict';
import test from 'node:test';
import { relaunchZipflow } from '../src/index.js';

test('restart launches the same Zipflow entry point with the original arguments and directory', () => {
  const calls = [];
  const child = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const result = relaunchZipflow({
    spawnImpl: (command, args, options) => { calls.push({ command, args, options }); return child; },
    execPath: '/usr/bin/node',
    argv: ['/usr/bin/node', '/global/zipflow/bin/zipflow.js', '--fixture'],
    cwd: '/project',
    env: { TEST: '1' },
  });

  assert.equal(result, child);
  assert.deepEqual(calls[0], {
    command: '/usr/bin/node',
    args: ['/global/zipflow/bin/zipflow.js', '--fixture'],
    options: { cwd: '/project', env: { TEST: '1' }, stdio: 'inherit' },
  });
  assert.equal(child.unrefCalled, true);
});
