import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKey, renderToString } from 'terlio.js';
import { tempDir } from '../test-support/helpers.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { renderZipflow } from '../src/ui/render.js';
import { openSettings, selectSetting, settingsViewModel } from '../src/app/settings-panel.js';

async function withSettingsHome(run) {
  const previous = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = await tempDir();
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
  }
}

async function settingsController(overrides = {}) {
  const state = createInitialState();
  state.project = { name: 'fixture', root: await tempDir('zipflow-settings-ux-project-') };
  state.screen = 'home';
  state.settings = { ...DEFAULT_SETTINGS, ...overrides };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  await openSettings(controller);
  return { state, controller };
}

async function selectCategory(controller, id) {
  const view = settingsViewModel(controller.state);
  const index = view.definitions.findIndex((item) => item.id === id);
  assert.notEqual(index, -1, `Missing settings category ${id}`);
  await selectSetting(controller, index);
  return settingsViewModel(controller.state);
}

test('Ctrl-J never activates a Settings item', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ archivePolicy: 'move' });
  await selectCategory(controller, 'sourceArchive');
  const before = settingsViewModel(state);
  assert.equal(before.focus, 'parameters');
  assert.equal(before.parameters[before.parameterIndex].id, 'archivePolicy');

  assert.equal(await controller.handleKey(parseKey('\n')), true);

  const after = settingsViewModel(state);
  assert.equal(after.focus, 'parameters');
  assert.equal(after.parameters[after.parameterIndex].id, 'archivePolicy');
  assert.equal(state.settings.archivePolicy, 'move');
  assert.equal(state.settingsPanel.modal, null);
}));

test('Ctrl-J does not activate ordinary menus outside text editors', async () => {
  const state = createInitialState();
  state.screen = 'home';
  state.menuItems = [{ id: 'action', label: 'Action' }];
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  let activations = 0;
  controller.activateSelected = async () => { activations += 1; };

  assert.equal(await controller.handleKey(parseKey('\n')), true);
  assert.equal(activations, 0);
});

test('Binaries show compact status markers, a header count, and one Check all action', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController();
  await selectCategory(controller, 'binaries');
  state.settingsPanel.loadingBinaries = false;
  state.settingsPanel.binaries = {
    git: { mode: 'automatic', valid: true, resolvedPath: '/usr/bin/git', version: 'git version 2.44.0' },
    npm: { mode: 'automatic', valid: false, error: 'npm was not found' },
  };
  const view = settingsViewModel(state);
  assert.equal(view.parameters.at(-1).id, 'binary-check-all');
  assert.equal(view.parameters.filter((item) => item.action === 'binary-check-all').length, 1);
  assert.equal(view.parameters.some((item) => item.action === 'binary-test'), false);
  assert.equal(view.parameters.find((item) => item.binaryId === 'git').value, 'Automatic · ✓');
  assert.equal(view.parameters.find((item) => item.binaryId === 'npm').value, 'Automatic · ✗');

  const output = stripAnsi(renderToString(renderZipflow({ state, width: 110, height: 30 }), { width: 110, height: 30 }));
  assert.match(output, /BINARIES · 1\//);
  assert.match(output, /Check all/);
  assert.doesNotMatch(output, /Test current executable|executables validated/i);
}));

test('long Russian Settings categories wrap instead of being truncated', () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture' };
  state.screen = 'settings';
  state.settings = { ...DEFAULT_SETTINGS, interfaceLanguage: 'ru' };
  state.i18n = { languageId: 'ru', available: [] };
  state.settingsPanel = {
    focus: 'categories', categoryIndex: 0, parameterIndices: {}, choiceIndices: {}, managedCount: 0,
    previous: { screen: 'home', menuItems: [], selectedIndex: 0, status: 'Ready' },
  };

  const output = stripAnsi(renderToString(renderZipflow({ state, width: 58, height: 24 }), { width: 58, height: 24 }));
  assert.match(output.replace(/\s+/g, ' '), /История управляемых файлов/);
  assert.doesNotMatch(output, /История управляемых…|История управляемых ф…/);
});

test('Russian deployment environment setting does not leak its English value', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ interfaceLanguage: 'ru', deployCommandEnvironment: 'inherit' });
  state.i18n = { languageId: 'ru', available: [] };
  await selectCategory(controller, 'commandEnvironment');
  const output = stripAnsi(renderToString(renderZipflow({ state, width: 90, height: 26 }), { width: 90, height: 26 }));
  assert.match(output, /Наследовать всё окружение/);
  assert.doesNotMatch(output, /Inherit full environment/);
}));

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}
