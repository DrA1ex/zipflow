import test from 'node:test';
import assert from 'node:assert/strict';
import { activeProcessCount, runProcess, terminateActiveProcesses } from '../src/utils/process.js';

test('active child processes are terminated during application cleanup', async () => {
  const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 60_000 });
  await waitFor(() => activeProcessCount() === 1);

  await terminateActiveProcesses({ graceMs: 20 });
  const result = await running;

  assert.equal(activeProcessCount(), 0);
  assert.notEqual(result.signal, null);
});

async function waitFor(predicate) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition was not reached.');
}
