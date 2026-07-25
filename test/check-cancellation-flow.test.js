import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { OperationManager } from '../src/operations/manager.js';
import { startChecks } from '../src/app/run-postcheck.js';


test('cancelling checks records cancellation without failed count or LLM explanation', async () => {
  const previousHome = process.env.ZIPFLOW_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), 'zipflow-check-flow-home-'));
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'zipflow-check-flow-project-'));
  process.env.ZIPFLOW_HOME = home;
  try {
    const state = {
      project: { root: projectPath, name: 'fixture' },
      workflow: {
        checks: [{
          id: 'slow', name: 'Slow check', kind: 'command', type: 'custom', selected: true, required: true,
          command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: '.', timeoutMs: 30_000,
        }],
        autonomy: { mode: 'manual' },
      },
      settings: {
        llmProvider: 'ollama', llmModel: 'must-not-run', llmUseFailedChecks: true,
      },
      run: {
        version: 9, id: 'zf-check-cancel-flow', status: 'applied', createdAt: new Date().toISOString(),
        projectPath, projectName: 'fixture', workflowName: 'fixture', applied: { changedPaths: [] },
      },
    };
    const manager = new OperationManager();
    const messages = [];
    const controller = {
      state,
      beginOperation(options) {
        const operation = manager.begin(options);
        setTimeout(() => operation.abort(), 40);
        return operation;
      },
      message(title) { messages.push(title); },
      invalidate() {},
      showMenu(screen) { state.screen = screen; },
    };

    await startChecks(controller);

    assert.equal(state.run.status, 'checks_cancelled');
    assert.equal(state.run.checks.cancelled, true);
    assert.equal(state.run.checks.failed, 0);
    assert.equal(state.run.checks.results.length, 0);
    assert.equal(state.run.llmFailure, undefined);
    assert.equal(messages.includes('Checks failed'), false);
    assert.equal(messages.includes('Local LLM error explanation'), false);
    assert.equal(state.screen, 'checks-cancelled');
    assert.equal(manager.current, null);
  } finally {
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
  }
});
