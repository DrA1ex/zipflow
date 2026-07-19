import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeploy } from '../src/deploy/runner.js';
import { tempDir } from '../test-support/helpers.js';

test('runs the configured deploy command in the project directory', async () => {
  const root = await tempDir();
  const result = await runDeploy({
    projectPath: root,
    deploy: {
      commandText: `${JSON.stringify(process.execPath)} -e "console.log(process.cwd())"`,
      cwd: '.',
      timeoutMs: 10_000,
    },
  });

  assert.equal(result.ok, true);
  assert.match(result.stdout, new RegExp(root.replaceAll('\\', '\\\\')));
});

test('fails clearly when deployment is enabled without a command', async () => {
  const result = await runDeploy({ projectPath: process.cwd(), deploy: { commandText: '' } });

  assert.equal(result.ok, false);
  assert.match(result.stderr, /not configured/i);
});
