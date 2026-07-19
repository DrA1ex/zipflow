import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { activateSetup, beginSetup } from '../src/app/setup-flow.js';

function projectFixture() {
  return {
    name: 'fixture',
    root: '/tmp/fixture',
    labels: ['Node.js'],
    technologies: [{ id: 'node' }],
    checks: [{ id: 'test', name: 'Unit tests', description: 'npm test', selected: true }],
    git: true,
  };
}

test('custom checks ask for the command before the display name', async () => {
  const state = createInitialState();
  state.project = projectFixture();
  const controller = new ZipflowController(state);

  await beginSetup(controller, { fresh: true });
  await activateSetup(controller, 'use-project');
  await activateSetup(controller, 'add-check');

  assert.equal(state.screen, 'custom-check-command');
  assert.equal(state.editorContext.label, 'Command to run');
  assert.match(state.editorContext.instructions.join(' '), /display name on the next step/i);
});

test('radio selection stays on the activated item and Space selects it', async () => {
  const state = createInitialState();
  state.project = projectFixture();
  const controller = new ZipflowController(state);

  await beginSetup(controller, { fresh: true });
  await activateSetup(controller, 'use-project');
  await activateSetup(controller, 'checks-continue');
  state.selectedIndex = state.menuItems.findIndex((item) => item.id === 'profile-trust');

  await controller.handleKey({ name: 'space', printable: true, text: ' ' });

  assert.equal(state.draft.policy.id, 'trust');
  assert.equal(state.menuItems[state.selectedIndex].id, 'profile-trust');
});

test('deployment command is requested only when deployment is enabled', async () => {
  const state = createInitialState();
  state.project = projectFixture();
  const controller = new ZipflowController(state);

  await beginSetup(controller, { fresh: true });
  await activateSetup(controller, 'use-project');
  await activateSetup(controller, 'checks-continue');
  await activateSetup(controller, 'policy-continue');
  await activateSetup(controller, 'archive-continue');
  await activateSetup(controller, 'checkpoint-continue');
  await activateSetup(controller, 'result-never');
  await activateSetup(controller, 'result-continue');

  assert.equal(state.screen, 'setup-deploy');
  await activateSetup(controller, 'deploy-on-demand');
  await activateSetup(controller, 'deploy-continue');

  assert.equal(state.screen, 'deploy-command');
  assert.equal(state.editorContext.label, 'Deploy command');
  assert.match(state.editorContext.instructions.join(' '), /only after every required check has passed/i);
});

test('projects without Git are offered initialization before workflow checks', async () => {
  const state = createInitialState();
  state.project = { ...projectFixture(), git: false };
  const controller = new ZipflowController(state);

  await beginSetup(controller, { fresh: true });
  await activateSetup(controller, 'use-project');

  assert.equal(state.screen, 'setup-git-init');
  assert.equal(state.menuItems[0].id, 'git-init');

  await activateSetup(controller, 'git-skip');
  assert.equal(state.screen, 'setup-checks');
  assert.equal(state.draft.git.checkpoint, 'never');
  assert.equal(state.draft.git.resultCommit, 'never');
});
