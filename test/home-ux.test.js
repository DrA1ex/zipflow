import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { projectSummary } from '../src/ui/format.js';

test('configured project home keeps workflow details in Activity instead of the action pane', () => {
  const state = createInitialState();
  state.project = {
    name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], technologies: [{ id: 'node' }],
    checks: [{ id: 'test', name: 'Unit tests', selected: true }], git: true,
  };
  state.workflow = createRecommendedWorkflow(state.project);
  const controller = new ZipflowController(state);
  controller.showHome();

  assert.equal(state.screen, 'home');
  assert.deepEqual(state.panelIntro, []);
  assert.ok(state.menuItems.some((item) => item.id === 'change-workflow'));
  assert.equal(state.menuItems.some((item) => item.id === 'fine-tune'), false);
  assert.equal(state.menuItems.some((item) => item.id === 'fresh-setup'), false);
  assert.equal(state.menuItems[0].id, 'start-update');
  const summary = projectSummary(state.project, state.workflow);
  assert.equal(summary.some((line) => /waiting for a ZIP archive/i.test(line)), false);
});

test('configured project home exposes manual tests and deployment when available', () => {
  const state = createInitialState();
  state.project = {
    name: 'fixture', root: '/tmp/fixture', labels: ['Swift · macOS'], technologies: [{ id: 'swift' }],
    checks: [], deployCandidates: [], git: true,
  };
  state.workflow = createRecommendedWorkflow(state.project);
  state.workflow.checks = [{ id: 'swift-test', name: 'Swift tests', selected: true }];
  state.workflow.deploy = { policy: 'on-demand', commandText: 'bash scripts/deploy.sh', cwd: '.' };
  const controller = new ZipflowController(state);

  controller.showHome();

  assert.ok(state.menuItems.some((item) => item.id === 'run-tests'));
  assert.ok(state.menuItems.some((item) => item.id === 'run-deploy-now'));
});


test('Escape on the project menu does not exit the application', async () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], git: true };
  state.workflow = workflowFixture();
  const controller = new ZipflowController(state);
  let exits = 0;
  controller.attachRuntime({ exit: () => { exits += 1; }, invalidate: () => {} });
  controller.showHome();

  await controller.handleKey({ name: 'escape' });

  assert.equal(exits, 0);
  assert.equal(state.screen, 'home');
  assert.match(state.status, /Exit or Ctrl\+C/);
});

function workflowFixture() {
  return {
    archive: { mode: 'overlay' }, checks: [], policy: { label: 'Practical' },
    git: { checkpoint: 'ask', resultCommit: 'ask' }, deploy: { policy: 'disabled' },
  };
}
