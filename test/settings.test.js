import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { renderToString } from 'terlio.js';
import { tempDir } from '../test-support/helpers.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/settings/store.js';
import { createInitialState } from '../src/app/state.js';
import { renderZipflow } from '../src/ui/render.js';
import { ZipflowController } from '../src/app/controller.js';
import {
  openSettings, selectOption, selectSetting, settingsViewModel, submitSettingsEditor,
} from '../src/app/settings-panel.js';
import { exists } from '../src/utils/fs.js';

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
  const project = await tempDir('zipflow-settings-project-');
  state.project = { name: 'fixture', root: project };
  state.screen = 'home';
  state.settings = { ...DEFAULT_SETTINGS, ...overrides };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  await openSettings(controller);
  return { state, controller };
}

async function selectDefinition(controller, id) {
  const view = settingsViewModel(controller.state);
  const index = view.definitions.findIndex((item) => item.id === id);
  assert.notEqual(index, -1, `Missing settings definition ${id}`);
  await selectSetting(controller, index);
  return settingsViewModel(controller.state);
}

async function selectOptionById(controller, id) {
  const view = settingsViewModel(controller.state);
  const index = view.options.findIndex((item) => item.id === id);
  assert.notEqual(index, -1, `Missing settings option ${id}`);
  await selectOption(controller, index);
}

test('global settings store theme, LLM authorization, and source archive defaults', async () => withSettingsHome(async () => {
  await saveSettings({
    theme: 'matrix', checkOutput: 'compact', llmProvider: 'ollama', llmModel: 'qwen-coder',
    llmLanguage: 'Russian', llmApiToken: 'secret', archivePolicy: 'move',
    archiveDirectory: '~/custom-archives', archiveRetentionDays: 45, archiveMaxBytes: 500_000_000,
  });
  const settings = await loadSettings();

  assert.equal(settings.theme, 'matrix');
  assert.equal(settings.checkOutput, 'compact');
  assert.equal(settings.llmProvider, 'ollama');
  assert.equal(settings.llmModel, 'qwen-coder');
  assert.equal(settings.llmLanguage, 'Russian');
  assert.equal(settings.llmApiToken, 'secret');
  assert.equal(settings.archivePolicy, 'move');
  assert.equal(settings.archiveDirectory, '~/custom-archives');
  assert.equal(settings.archiveRetentionDays, 45);
  assert.equal(settings.archiveMaxBytes, 500_000_000);
}));

test('new settings default to keeping source ZIPs for 30 days and 1 GB when archiving is enabled', () => {
  assert.equal(DEFAULT_SETTINGS.archivePolicy, 'keep');
  assert.equal(DEFAULT_SETTINGS.archiveDirectory, '~/zipflow-archive');
  assert.equal(DEFAULT_SETTINGS.archiveRetentionDays, 30);
  assert.equal(DEFAULT_SETTINGS.archiveMaxBytes, 1_000_000_000);
});

test('renders a stable two-pane settings list without adding dependent fields on the left', () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture' };
  state.screen = 'settings';
  state.settings = { ...DEFAULT_SETTINGS, archivePolicy: 'move' };
  state.settingsPanel = {
    focus: 'settings', settingIndex: 0, optionIndex: 0, managedCount: 0,
    previous: { screen: 'home', menuItems: [], selectedIndex: 0, status: 'Ready' },
  };

  const view = settingsViewModel(state);
  const output = renderToString(renderZipflow({ state, width: 110, height: 30 }), { width: 110, height: 30 });

  assert.deepEqual(view.definitions.map((item) => item.id), ['theme', 'checkOutput', 'localLlm', 'sourceArchive', 'managedHistory']);
  assert.match(output, /Source archives/);
  assert.doesNotMatch(output, /Archive retention —/);
});

test('enabling archive storage keeps focus on the selected policy while revealing its dependent controls', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ archivePolicy: 'keep' });
  await selectDefinition(controller, 'sourceArchive');
  const settingIndex = state.settingsPanel.settingIndex;
  await selectOptionById(controller, 'archivePolicy:move');
  const view = settingsViewModel(state);

  assert.equal(state.settings.archivePolicy, 'move');
  assert.equal(state.settingsPanel.settingIndex, settingIndex);
  assert.equal(view.options[state.settingsPanel.optionIndex].id, 'archivePolicy:move');
  assert.ok(view.options.some((item) => item.id === 'edit:archiveRetentionDays'));
}));

test('archive retention controls stay inside the source archive options pane', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ archivePolicy: 'move' });
  const view = await selectDefinition(controller, 'sourceArchive');

  assert.equal(view.definitions.some((item) => item.id === 'archiveRetentionDays'), false);
  assert.ok(view.options.some((item) => item.id === 'edit:archiveDirectory'));
  assert.ok(view.options.some((item) => item.id === 'edit:archiveRetentionDays'));
  assert.ok(view.options.some((item) => item.id === 'edit:archiveMaxBytes'));
  assert.equal(state.screen, 'settings');
}));

test('archive directory opens in a modal and creates the configured folder', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ archivePolicy: 'move' });
  await selectDefinition(controller, 'sourceArchive');
  await selectOptionById(controller, 'edit:archiveDirectory');

  assert.equal(state.screen, 'settings');
  assert.equal(state.settingsPanel.modal.field.id, 'archiveDirectory');

  const target = path.join(await tempDir('zipflow-settings-storage-'), 'new-folder');
  state.editor.set(target);
  await submitSettingsEditor(controller);

  assert.equal(state.settings.archiveDirectory, target);
  assert.equal(await exists(target), true);
  assert.equal(state.settingsPanel.modal, null);
}));

test('numeric archive settings validate input in the modal and show their units', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ archivePolicy: 'move' });
  await selectDefinition(controller, 'sourceArchive');
  await selectOptionById(controller, 'edit:archiveRetentionDays');

  let output = renderToString(renderZipflow({ state, width: 110, height: 30 }), { width: 110, height: 30 });
  assert.match(output, /Unit: whole days/);
  assert.match(output, /Edit Archive retention/);

  state.editor.set('thirty');
  await submitSettingsEditor(controller);
  assert.equal(state.settings.archiveRetentionDays, 30);
  assert.match(state.settingsPanel.modal.error, /whole number of days/);

  state.editor.set('45');
  await submitSettingsEditor(controller);
  assert.equal(state.settings.archiveRetentionDays, 45);
  assert.equal(state.settingsPanel.modal, null);

  await selectOptionById(controller, 'edit:archiveMaxBytes');
  output = renderToString(renderZipflow({ state, width: 110, height: 30 }), { width: 110, height: 30 });
  assert.match(output, /Units: B, KB, MB, GB, KiB, MiB, GiB/);
  state.editor.set('not-a-size');
  await submitSettingsEditor(controller);
  assert.match(state.settingsPanel.modal.error, /500MB, 1GB, or 2GiB/);
}));

test('LLM token uses the same modal pattern and never pre-fills the stored secret', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ llmProvider: 'ollama', llmApiToken: 'secret' });
  await selectDefinition(controller, 'localLlm');
  await selectOptionById(controller, 'edit-llm-token');

  assert.equal(state.screen, 'settings');
  assert.equal(state.settingsPanel.modal.field.id, 'llmApiToken');
  assert.equal(state.editor.value, '');

  state.editor.set('replacement');
  await submitSettingsEditor(controller);
  assert.equal(state.settings.llmApiToken, 'replacement');
}));
