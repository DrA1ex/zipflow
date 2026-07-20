import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';

test('configured project home shows selected defaults before fine-tuning', () => {
  const state = createInitialState();
  state.project = {
    name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], technologies: [{ id: 'node' }],
    checks: [{ id: 'test', name: 'Unit tests', selected: true }], git: true,
  };
  state.workflow = createRecommendedWorkflow(state.project);
  const controller = new ZipflowController(state);
  controller.showHome();

  assert.equal(state.screen, 'home');
  assert.ok(state.panelIntro.some((line) => /Archive: Overlay/.test(line)));
  assert.ok(state.panelIntro.some((line) => /Checks: Unit tests/.test(line)));
  assert.ok(state.menuItems.some((item) => item.id === 'fine-tune'));
  assert.equal(state.menuItems[0].id, 'start-update');
});
