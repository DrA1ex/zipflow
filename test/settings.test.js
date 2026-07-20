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
  handleSettingsKey, openSettings, selectChoice, selectParameter, selectSetting, settingsViewModel, submitSettingsEditor,
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

async function selectCategory(controller, id) {
  const view = settingsViewModel(controller.state);
  const index = view.definitions.findIndex((item) => item.id === id);
  assert.notEqual(index, -1, `Missing settings category ${id}`);
  await selectSetting(controller, index);
  return settingsViewModel(controller.state);
}

async function openParameter(controller, id) {
  const view = settingsViewModel(controller.state);
  const index = view.parameters.findIndex((item) => item.id === id);
  assert.notEqual(index, -1, `Missing settings parameter ${id}`);
  await selectParameter(controller, index);
  return settingsViewModel(controller.state);
}

async function chooseValue(controller, id) {
  const view = settingsViewModel(controller.state);
  const index = view.choices.findIndex((item) => item.id === id);
  assert.notEqual(index, -1, `Missing settings choice ${id}`);
  await selectChoice(controller, index);
}

test('global settings store theme, LLM authorization, and source archive defaults', async () => withSettingsHome(async () => {
  await saveSettings({
    theme: 'matrix', checkOutput: 'compact', llmProvider: 'ollama', llmModel: 'qwen-coder',
    llmLanguage: 'Russian', llmApiToken: 'secret', llmArchiveReview: 'patch', archivePolicy: 'move',
    archiveDirectory: '~/custom-archives', archiveRetentionDays: 45, archiveMaxBytes: 500_000_000,
  });
  const settings = await loadSettings();

  assert.equal(settings.theme, 'matrix');
  assert.equal(settings.checkOutput, 'compact');
  assert.equal(settings.llmProvider, 'ollama');
  assert.equal(settings.llmModel, 'qwen-coder');
  assert.equal(settings.llmLanguage, 'Russian');
  assert.equal(settings.llmApiToken, 'secret');
  assert.equal(settings.llmArchiveReview, 'patch');
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

test('settings keep categories on the left and the selected category page on the right', () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture' };
  state.screen = 'settings';
  state.settings = { ...DEFAULT_SETTINGS };
  state.settingsPanel = {
    focus: 'categories', categoryIndex: 0, parameterIndices: {}, choiceIndices: {}, managedCount: 0,
    previous: { screen: 'home', menuItems: [], selectedIndex: 0, status: 'Ready' },
  };

  const view = settingsViewModel(state);
  const output = renderToString(renderZipflow({ state, width: 110, height: 30 }), { width: 110, height: 30 });

  assert.equal(view.focus, 'categories');
  assert.deepEqual(view.definitions.map((item) => item.id), ['theme', 'checkOutput', 'localLlm', 'sourceArchive', 'managedHistory']);
  assert.equal(view.parameters[0].id, 'theme');
  assert.match(output, /CATEGORIES/);
  assert.match(output, /THEME/);
  assert.match(output, /Theme: Ocean/);
});

test('a choice replaces only the right pane and returns to the originating parameter on Enter', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ archivePolicy: 'move' });
  await selectCategory(controller, 'sourceArchive');
  let view = await openParameter(controller, 'archivePolicy');

  assert.equal(view.focus, 'choices');
  assert.equal(view.choices[view.choiceIndex].id, 'archivePolicy:move');
  let output = renderToString(renderZipflow({ state, width: 110, height: 30 }), { width: 110, height: 30 });
  assert.match(output, /CATEGORIES/);
  assert.match(output, /CHOOSE VALUE/i);

  await chooseValue(controller, 'archivePolicy:keep');
  view = settingsViewModel(state);
  assert.equal(view.focus, 'parameters');
  assert.equal(view.parameters[view.parameterIndex].id, 'archivePolicy');
  assert.equal(state.settings.archivePolicy, 'keep');
}));

test('Escape from a nested value list returns to the same parameter without changing it', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ archivePolicy: 'move' });
  await selectCategory(controller, 'sourceArchive');
  await openParameter(controller, 'archivePolicy');
  await handleSettingsKey(controller, { name: 'down' });
  await handleSettingsKey(controller, { name: 'escape' });

  const view = settingsViewModel(state);
  assert.equal(view.focus, 'parameters');
  assert.equal(view.parameters[view.parameterIndex].id, 'archivePolicy');
  assert.equal(state.settings.archivePolicy, 'move');
}));

test('language choice opens with the current language selected and returns to Language', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController();
  state.settings = { ...state.settings, llmProvider: 'ollama', llmModel: 'qwen', llmLanguage: 'Russian' };
  state.settingsPanel.modelsProvider = 'ollama';
  state.settingsPanel.models = [{ id: 'qwen', key: 'qwen', label: 'qwen', loaded: true }];
  await selectCategory(controller, 'localLlm');
  let view = await openParameter(controller, 'llmLanguage');

  assert.equal(view.choices[view.choiceIndex].id, 'llmLanguage:Russian');
  await chooseValue(controller, 'llmLanguage:English');
  view = settingsViewModel(state);
  assert.equal(view.focus, 'parameters');
  assert.equal(view.parameters[view.parameterIndex].id, 'llmLanguage');
  assert.equal(state.settings.llmLanguage, 'English');
}));

test('archive storage parameters stay on one page and input values open in a modal', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ archivePolicy: 'move' });
  const view = await selectCategory(controller, 'sourceArchive');
  assert.deepEqual(view.parameters.map((item) => item.id), [
    'archivePolicy', 'archiveDirectory', 'archiveRetentionDays', 'archiveMaxBytes',
  ]);

  await openParameter(controller, 'archiveDirectory');
  assert.equal(state.screen, 'settings');
  assert.equal(state.settingsPanel.modal.field.id, 'archiveDirectory');

  const target = path.join(await tempDir('zipflow-settings-storage-'), 'new-folder');
  state.editor.set(target);
  await submitSettingsEditor(controller);
  assert.equal(state.settings.archiveDirectory, target);
  assert.equal(await exists(target), true);
  assert.equal(state.settingsPanel.modal, null);
  assert.equal(settingsViewModel(state).parameters[settingsViewModel(state).parameterIndex].id, 'archiveDirectory');
}));

test('numeric archive settings validate input in the modal and show their units', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ archivePolicy: 'move' });
  await selectCategory(controller, 'sourceArchive');
  await openParameter(controller, 'archiveRetentionDays');

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

  await openParameter(controller, 'archiveMaxBytes');
  output = renderToString(renderZipflow({ state, width: 110, height: 30 }), { width: 110, height: 30 });
  assert.match(output, /Units: B, KB, MB, GB, KiB, MiB, GiB/);
  state.editor.set('not-a-size');
  await submitSettingsEditor(controller);
  assert.match(state.settingsPanel.modal.error, /500MB, 1GB, or 2GiB/);
}));

test('LLM token uses a modal and never pre-fills the stored secret', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({ llmProvider: 'disabled', llmApiToken: 'secret' });
  await selectCategory(controller, 'localLlm');
  await openParameter(controller, 'llmApiToken');

  assert.equal(state.settingsPanel.modal.field.id, 'llmApiToken');
  assert.equal(state.editor.value, '');
  state.editor.set('replacement');
  await submitSettingsEditor(controller);
  assert.equal(state.settings.llmApiToken, 'replacement');
  assert.equal(settingsViewModel(state).parameters[settingsViewModel(state).parameterIndex].id, 'llmApiToken');
}));

test('archive review mode is selected from the Local LLM page and preserves the originating parameter', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({
    llmProvider: 'lmstudio', llmModel: 'gemma', llmArchiveReview: 'structure',
  });
  state.settingsPanel.modelsProvider = 'lmstudio';
  state.settingsPanel.models = [{ id: 'gemma', key: 'gemma', label: 'gemma', loaded: true }];
  await selectCategory(controller, 'localLlm');
  let view = await openParameter(controller, 'llmArchiveReview');
  assert.equal(view.choices[view.choiceIndex].id, 'llmArchiveReview:structure');
  await chooseValue(controller, 'llmArchiveReview:patch');
  view = settingsViewModel(state);
  assert.equal(state.settings.llmArchiveReview, 'patch');
  assert.equal(view.parameters[view.parameterIndex].id, 'llmArchiveReview');
}));
