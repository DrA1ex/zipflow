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
