import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { discoverProject } from '../src/project/detect.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import {
  activateProjectConfirm, activateProjectStructure, showProjectStructureStep, submitProjectSetupEditor,
} from '../src/app/setup-projects.js';
import { beginCustomCheck, showChecksStep, submitCustomCheckEditor } from '../src/app/setup-checks.js';
import { showDeployCommandStep, showDeployEditor, submitDeployEditor } from '../src/app/setup-deploy.js';
import { acceptPathSuggestion, refreshPathSuggestions } from '../src/app/path-suggestions.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-multi-ui-'));
  await write(root, 'pyproject.toml', '[project]\nname="workspace"\n');
  await write(root, 'web/package.json', JSON.stringify({ scripts: { test: 'node --test', deploy: 'echo deploy' } }));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function fakeController(project) {
  const state = {
    project,
    draft: createRecommendedWorkflow(project),
    workflow: null,
    setupEditing: false,
    screen: 'setup-project',
    editor: { value: '', set(value) { this.value = value; } },
    editorContext: null,
    pendingProjectEntry: null,
  };
  return {
    state,
    messages: [],
    showMenu(screen, items, status, selectedIndex = 0, intro = []) {
      Object.assign(state, { screen, menuItems: items, status, selectedIndex: selectedIndex ?? 0, panelIntro: intro });
    },
    showEditor(screen, context, value = '') {
      Object.assign(state, { screen, editorContext: context });
      state.editor.value = value;
    },
    message(title, lines, tone) { this.messages.push({ title, lines, tone }); },
    setStatus(status) { state.status = status; },
  };
}

test('project structure screen shows detected projects and permits root-only mode', async () => {
  const { root, cleanup } = await fixture();
  try {
    const controller = fakeController(await discoverProject(root));
    showProjectStructureStep(controller);

    assert.equal(controller.state.screen, 'setup-project');
    assert.ok(controller.state.menuItems.some((item) => /Workspace root/.test(item.label)));
    assert.ok(controller.state.menuItems.some((item) => /web\//.test(item.label)));
    assert.ok(controller.state.menuItems.some((item) => item.id === 'add-project'));

    let continued = false;
    await activateProjectStructure(controller, 'use-root-only', () => { continued = true; });
    assert.equal(continued, true);
    assert.deepEqual(controller.state.draft.projects.map((entry) => entry.path), ['.']);
    assert.equal(controller.state.draft.checks.some((check) => check.cwd === 'web'), false);
  } finally {
    await cleanup();
  }
});

test('a single root project is informational and cannot be deselected', async () => {
  const { root, cleanup } = await fixture();
  try {
    await rm(path.join(root, 'web'), { recursive: true, force: true });
    const controller = fakeController(await discoverProject(root));
    showProjectStructureStep(controller);

    assert.equal(controller.state.menuItems.some((item) => item.id.startsWith('project-toggle:')), false);
    assert.equal(controller.state.menuItems.find((item) => item.id === 'project-summary')?.disabled, true);
    let continued = false;
    await activateProjectStructure(controller, 'use-project', () => { continued = true; });
    assert.equal(continued, true);
    assert.deepEqual(controller.state.draft.projects.map((entry) => entry.path), ['.']);
  } finally {
    await cleanup();
  }
});

test('manual project editor adds a deeper directory after confirmation', async () => {
  const { root, cleanup } = await fixture();
  try {
    await write(root, 'packages/admin/package.json', '{"name":"admin"}');
    const controller = fakeController(await discoverProject(root));
    await activateProjectStructure(controller, 'add-project', () => {});
    assert.equal(controller.state.screen, 'project-entry-path');

    controller.state.editor.value = 'packages/admin';
    await submitProjectSetupEditor(controller);
    assert.equal(controller.state.screen, 'setup-project-confirm');
    assert.deepEqual(controller.state.pendingProjectEntry.labels, ['Node.js']);

    activateProjectConfirm(controller, 'project-confirm-add');
    assert.ok(controller.state.project.projects.some((entry) => entry.path === 'packages/admin'));
    assert.ok(controller.state.draft.projects.some((entry) => entry.path === 'packages/admin'));
  } finally {
    await cleanup();
  }
});

test('custom check and deploy editors expose and persist compact cwd syntax', async () => {
  const { root, cleanup } = await fixture();
  try {
    const controller = fakeController(await discoverProject(root));

    showChecksStep(controller);
    assert.ok(controller.state.menuItems.some((item) => item.description.includes('web/')));
    beginCustomCheck(controller);
    assert.match(controller.state.editorContext.placeholder, /web\/ :: npm test/);
    controller.state.editor.value = 'web/ :: npm run integration';
    await submitCustomCheckEditor(controller);
    assert.equal(controller.state.screen, 'custom-check-name');
    assert.match(controller.state.editorContext.instructions.join(' '), /Directory: web\//);
    controller.state.editor.value = 'Web integration';
    await submitCustomCheckEditor(controller);
    const check = controller.state.draft.checks.find((item) => item.name === 'Web integration');
    assert.equal(check.cwd, 'web');
    assert.equal(check.commandText, 'npm run integration');

    showDeployCommandStep(controller);
    assert.ok(controller.state.menuItems.some((item) => item.description.includes('web/')));
    showDeployEditor(controller);
    assert.match(controller.state.editorContext.placeholder, /web\/ :: npm run deploy/);
    controller.state.editor.value = 'web/ :: npm run deploy:preview';
    await submitDeployEditor(controller, () => {});
    assert.equal(controller.state.draft.deploy.cwd, 'web');
    assert.equal(controller.state.draft.deploy.commandText, 'npm run deploy:preview');
  } finally {
    await cleanup();
  }
});


test('command path completion inserts the cwd prefix before the shell command', async () => {
  const { root, cleanup } = await fixture();
  try {
    await mkdir(path.join(root, 'packages', 'client'), { recursive: true });
    const controller = fakeController(await discoverProject(root));
    controller.state.screen = 'custom-check-command';
    controller.state.editor.value = 'packages/cl';
    controller.state.pathSuggestionActive = true;
    controller.invalidate = () => {};
    await refreshPathSuggestions(controller);

    assert.ok(controller.state.pathSuggestions.items.some((item) => item.insert === 'packages/client/ :: '));
    controller.state.pathSuggestions.selectedIndex = controller.state.pathSuggestions.items.findIndex((item) => item.insert === 'packages/client/ :: ');
    await acceptPathSuggestion(controller);
    assert.equal(controller.state.editor.value, 'packages/client/ :: ');
    assert.equal(controller.state.pathSuggestions, null);
  } finally {
    await cleanup();
  }
});
