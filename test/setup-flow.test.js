import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { activateSetup, beginSetup } from '../src/app/setup-flow.js';
import { discoverProject } from '../src/project/detect.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { tempDir, writeFiles } from '../test-support/helpers.js';

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


test('workflow settings can start over without replacing the saved workflow before save', async () => {
  const root = await tempDir('zipflow-setup-restart-');
  await writeFiles(root, {
    'package.json': '{"name":"restart-fixture","scripts":{"test":"node --test"}}\n',
    'web/package.json': '{"name":"restart-web","scripts":{"test":"node --test"}}\n',
  });
  const state = createInitialState();
  state.project = await discoverProject(root);
  state.workflow = createRecommendedWorkflow(state.project);
  state.workflow.projects = state.workflow.projects.map((entry) => ({ ...entry, selected: entry.path === '.' }));
  state.workflow.checks = state.workflow.checks.filter((check) => (check.cwd ?? '.') === '.');
  state.workflow.policy = { ...state.workflow.policy, id: 'trust', label: 'Trust archive' };
  const savedWorkflow = structuredClone(state.workflow);
  const controller = new ZipflowController(state);

  await beginSetup(controller, { fresh: false });
  assert.equal(state.screen, 'setup-sections');
  assert.ok(state.menuItems.some((item) => item.id === 'section-restart'));

  await activateSetup(controller, 'section-restart');
  assert.equal(state.screen, 'setup-restart-confirm');
  await activateSetup(controller, 'restart-workflow-cancel');
  assert.equal(state.screen, 'setup-sections');
  assert.deepEqual(state.workflow, savedWorkflow);
  assert.equal(state.draft.policy.id, 'trust');

  await activateSetup(controller, 'section-restart');
  await activateSetup(controller, 'restart-workflow-confirm');
  assert.equal(state.screen, 'setup-project');
  assert.deepEqual(state.workflow, savedWorkflow);
  assert.equal(state.draft.policy.id, 'practical');
  assert.deepEqual(state.project.activeProjects.map((entry) => entry.path), ['.', 'web']);

  await controller.back();
  assert.equal(state.screen, 'home');
  assert.deepEqual(state.workflow, savedWorkflow);
  assert.deepEqual(state.project.activeProjects.map((entry) => entry.path), ['.']);
});

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


test('Shift+Up and Shift+Down reorder workflow checks without toggling them', async () => {
  const state = createInitialState();
  state.project = projectFixture();
  state.project.checks = [
    { id: 'lint', name: 'Lint', description: 'npm run lint', selected: true },
    { id: 'test', name: 'Unit tests', description: 'npm test', selected: true },
    { id: 'types', name: 'Type check', description: 'npm run typecheck', selected: true },
  ];
  const controller = new ZipflowController(state);

  await beginSetup(controller, { fresh: true });
  await activateSetup(controller, 'use-project');
  state.selectedIndex = state.menuItems.findIndex((item) => item.id === 'check:1');

  await controller.handleKey({ name: 'up', shift: true });
  assert.deepEqual(state.draft.checks.map((check) => check.id), ['test', 'lint', 'types']);
  assert.equal(state.menuItems[state.selectedIndex].id, 'check:0');
  assert.equal(state.draft.checks[0].selected, true);
  assert.equal(state.status, 'Check moved up');

  await controller.handleKey({ name: 'down', shift: true });
  assert.deepEqual(state.draft.checks.map((check) => check.id), ['lint', 'test', 'types']);
  assert.equal(state.menuItems[state.selectedIndex].id, 'check:1');
  assert.equal(state.status, 'Check moved down');
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
  await activateSetup(controller, 'autonomy-continue');
  await activateSetup(controller, 'archive-continue');
  await activateSetup(controller, 'checkpoint-continue');
  await activateSetup(controller, 'result-never');
  await activateSetup(controller, 'result-continue');

  assert.equal(state.screen, 'setup-deploy');
  await activateSetup(controller, 'deploy-on-demand');
  await activateSetup(controller, 'deploy-continue');

  assert.equal(state.screen, 'setup-deploy-command');
  assert.ok(state.menuItems.some((item) => item.id === 'deploy-custom'));
  await activateSetup(controller, 'deploy-custom');
  assert.equal(state.screen, 'deploy-command');
  assert.equal(state.editorContext.label, 'Deploy command');
  assert.match(state.editorContext.instructions.join(' '), /only after every required update check passes/i);
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


test('Git initialization never offers to rewrite an existing gitignore', async () => {
  const root = await tempDir('zipflow-setup-existing-ignore-');
  const original = '# Keep exactly this file\ncustom-cache/\n';
  await writeFiles(root, {
    'package.json': '{"name":"fixture"}\n',
    '.gitignore': original,
  });
  const state = createInitialState();
  state.project = await discoverProject(root);
  const controller = new ZipflowController(state);

  await beginSetup(controller, { fresh: true });
  await activateSetup(controller, 'use-project');
  await activateSetup(controller, 'git-init');

  assert.equal(state.screen, 'setup-gitignore');
  assert.equal(state.menuItems.some((item) => item.id === 'gitignore-add'), false);
  assert.equal(state.menuItems[0].id, 'gitignore-existing');

  await activateSetup(controller, 'gitignore-existing');
  assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), original);
  assert.equal(state.screen, 'setup-initial-commit');
});

test('deployment setup offers detected commands before a custom command', async () => {
  const state = createInitialState();
  state.project = {
    ...projectFixture(),
    deployCandidates: [{
      id: 'deploy:script', name: 'Deploy Release', description: 'bash scripts/deploy-release.sh',
      commandText: 'bash scripts/deploy-release.sh', cwd: '.', source: './scripts',
    }],
  };
  const controller = new ZipflowController(state);

  await beginSetup(controller, { fresh: true });
  await activateSetup(controller, 'use-project');
  await activateSetup(controller, 'checks-continue');
  await activateSetup(controller, 'policy-continue');
  await activateSetup(controller, 'autonomy-continue');
  await activateSetup(controller, 'archive-continue');
  await activateSetup(controller, 'checkpoint-continue');
  await activateSetup(controller, 'result-never');
  await activateSetup(controller, 'result-continue');
  await activateSetup(controller, 'deploy-on-demand');
  await activateSetup(controller, 'deploy-continue');

  assert.equal(state.screen, 'setup-deploy-command');
  assert.equal(state.menuItems[0].id, 'deploy-candidate:0');
  await activateSetup(controller, 'deploy-candidate:0');
  assert.equal(state.draft.deploy.commandText, 'bash scripts/deploy-release.sh');
});
