import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { beginManualChecks, beginManualDeploy } from '../src/app/manual-flow.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { runReportPath } from '../src/runs/store.js';
import { tempDir, writeFiles } from '../test-support/helpers.js';

function fixture(root) {
  const project = { name: 'fixture', root, labels: ['Node.js'], technologies: [{ id: 'node' }], checks: [], deployCandidates: [], git: false };
  const workflow = createRecommendedWorkflow(project);
  return { project, workflow };
}

test('manual tests run against current files and write a report', async () => {
  const home = await tempDir('zipflow-manual-home-');
  process.env.ZIPFLOW_HOME = home;
  const root = await tempDir('zipflow-manual-checks-');
  await writeFiles(root, { 'index.js': 'export const value = 1;\n' });
  const { project, workflow } = fixture(root);
  workflow.checks = [{
    id: 'manual-pass', name: 'Current version test', description: 'node test', kind: 'command', type: 'test',
    command: [process.execPath, '-e', 'process.exit(0)'], selected: true, required: true, timeoutMs: 10_000,
  }];
  const state = createInitialState();
  Object.assign(state, { project, workflow });
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  await beginManualChecks(controller);

  assert.equal(state.screen, 'manual-checks-result');
  assert.equal(state.run.kind, 'manual-checks');
  assert.equal(state.run.checks.passed, 1);
  assert.match(await readFile(runReportPath(state.run.id), 'utf8'), /Action: Manual tests against current project/);
});

test('manual failed tests offer LLM explanation only as an explicit action', async () => {
  const home = await tempDir('zipflow-manual-llm-home-');
  process.env.ZIPFLOW_HOME = home;
  const root = await tempDir('zipflow-manual-fail-');
  await writeFiles(root, { 'index.js': 'export {};\n' });
  const { project, workflow } = fixture(root);
  workflow.checks = [{
    id: 'manual-fail', name: 'Failing test', description: 'fail', kind: 'command', type: 'test',
    command: [process.execPath, '-e', 'process.exit(2)'], selected: true, required: true, timeoutMs: 10_000,
  }];
  const state = createInitialState();
  Object.assign(state, { project, workflow });
  Object.assign(state.settings, { llmProvider: 'lmstudio', llmModel: 'fixture-model', llmUseFailedChecks: true, llmFailureAnalysis: 'new-context' });
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  await beginManualChecks(controller);

  assert.equal(state.run.llmFailure, null);
  assert.ok(state.menuItems.some((item) => item.id === 'manual-explain'));
});

test('manual deployment runs the configured current-version command and writes a report', async () => {
  const home = await tempDir('zipflow-manual-deploy-home-');
  process.env.ZIPFLOW_HOME = home;
  const root = await tempDir('zipflow-manual-deploy-');
  const { project, workflow } = fixture(root);
  workflow.deploy = {
    policy: 'on-demand', commandText: `${JSON.stringify(process.execPath)} -e "console.log('deployed')"`, cwd: '.', timeoutMs: 10_000,
  };
  const state = createInitialState();
  Object.assign(state, { project, workflow });
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  await beginManualDeploy(controller);

  assert.equal(state.screen, 'manual-deploy-result');
  assert.equal(state.run.kind, 'manual-deploy');
  assert.equal(state.run.deploy.ok, true);
  assert.match(await readFile(path.join(home, 'runs', state.run.id, 'report.txt'), 'utf8'), /Action: Manual deployment of current project/);
});
