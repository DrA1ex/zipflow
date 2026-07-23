import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayManager, renderToString } from 'terlio.js';
import { tempDir } from '../test-support/helpers.js';
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings } from '../src/settings/store.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import {
  handleSettingsKey, openSettings, selectParameter, selectSetting, settingsViewModel,
} from '../src/app/settings-panel.js';

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
  state.project = { name: 'fixture', root: await tempDir('zipflow-settings-project-') };
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

test('saveSettings preserves existing LLM task selection when only an unrelated field is supplied', async () => withSettingsHome(async () => {
  await saveSettings({
    ...DEFAULT_SETTINGS,
    llmProvider: 'ollama', llmModel: 'qwen',
    llmUseArchiveReview: true, llmUseSummary: false,
    llmUseFailedChecks: true, llmUseCommitMessage: false,
  });
  await saveSettings({ theme: 'matrix' });

  const settings = await loadSettings();
  assert.equal(settings.theme, 'matrix');
  assert.equal(settings.llmUseArchiveReview, true);
  assert.equal(settings.llmUseSummary, false);
  assert.equal(settings.llmUseFailedChecks, true);
  assert.equal(settings.llmUseCommitMessage, false);
}));

test('Settings help includes the full parameter context, selected option, and structured storage statistics', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({
    llmProvider: 'ollama', llmModel: 'qwen', llmUseArchiveReview: true, llmArchiveReview: 'structure',
  });
  state.overlays = createOverlayManager();

  await selectCategory(controller, 'localLlm');
  await openParameter(controller, 'llmArchiveReview');
  await handleSettingsKey(controller, { printable: true, text: '?' });
  let overlay = state.overlays.top();
  let output = renderToString(overlay.render({ width: 76, height: 18 }), { width: 76, height: 18 });
  assert.match(output, /Choose how archive suitability is assessed/);
  assert.match(output, /Compare the project and archive trees/);
  state.overlays.handleKey({ name: 'escape' });

  await selectCategory(controller, 'backups');
  state.settingsPanel.storageStats = {
    archives: { count: 0, totalBytes: 0, oldestAt: null },
    backups: { count: 4, fileCount: 27, totalBytes: 2_048, oldestAt: '2026-01-02T05:00:00.000Z' },
  };
  await handleSettingsKey(controller, { printable: true, text: '?' });
  overlay = state.overlays.top();
  output = renderToString(overlay.render({ width: 76, height: 18 }), { width: 76, height: 18 });
  assert.match(output, /Keep every backup or automatically remove/);
  assert.match(output, /Storage statistics/);
  assert.match(output, /Backups: 4/);
  assert.match(output, /Stored files: 27/);
  assert.match(output, /Total size: 2\.05 KB/);
  assert.match(output, /Oldest backup:/);
  state.overlays.handleKey({ name: 'escape' });

  await selectCategory(controller, 'sourceArchive');
  state.settingsPanel.storageStats = {
    archives: { count: 6, totalBytes: 8_192, oldestAt: '2026-01-01T05:00:00.000Z' },
    backups: { count: 0, fileCount: 0, totalBytes: 0, oldestAt: null },
  };
  await handleSettingsKey(controller, { printable: true, text: '?' });
  overlay = state.overlays.top();
  output = renderToString(overlay.render({ width: 76, height: 18 }), { width: 76, height: 18 });
  assert.match(output, /Retention and storage for completed source ZIPs/);
  assert.match(output, /Archives: 6/);
  assert.match(output, /Total size: 8\.19 KB/);
  assert.match(output, /Oldest archive:/);
  state.overlays.handleKey({ name: 'escape' });

  await selectCategory(controller, 'managedHistory');
  state.settingsPanel.managedHistory = {
    paths: ['src/a.js', 'src/b.js', 'web/app.js'], updatedAt: '2026-01-03T05:00:00.000Z',
  };
  await handleSettingsKey(controller, { printable: true, text: '?' });
  overlay = state.overlays.top();
  output = renderToString(overlay.render({ width: 76, height: 18 }), { width: 76, height: 18 });
  assert.match(output, /Control whether successful updates record managed paths/);
  assert.match(output, /Managed-file statistics/);
  assert.match(output, /Recorded paths: 3/);
  assert.match(output, /Last updated:/);
}));

test('LLM tasks are independent checkboxes and task-specific methods stay disabled until needed', async () => withSettingsHome(async () => {
  const { state, controller } = await settingsController({
    llmProvider: 'ollama', llmModel: 'qwen', llmUseArchiveReview: false,
    llmUseSummary: true, llmUseFailedChecks: false, llmUseCommitMessage: true,
  });
  await selectCategory(controller, 'localLlm');
  let view = settingsViewModel(state);
  assert.equal(view.parameters.find((item) => item.id === 'llmArchiveReview').disabled, true);
  assert.equal(view.parameters.find((item) => item.id === 'llmFailureAnalysis').disabled, true);

  view = await openParameter(controller, 'llmTasks');
  assert.equal(state.settingsPanel.subpage, 'llmTasks');
  assert.deepEqual(view.parameters.slice(0, 4).map((item) => [item.id, item.type, item.selected]), [
    ['llmUseArchiveReview', 'toggle', false],
    ['llmUseSummary', 'toggle', true],
    ['llmUseFailedChecks', 'toggle', false],
    ['llmUseCommitMessage', 'toggle', true],
  ]);

  await selectParameter(controller, 0);
  await selectParameter(controller, 1);
  await selectParameter(controller, 2);
  assert.equal(state.settings.llmUseArchiveReview, true);
  assert.equal(state.settings.llmUseSummary, false);
  assert.equal(state.settings.llmUseFailedChecks, true);
  assert.equal(state.settings.llmUseCommitMessage, true);

  await handleSettingsKey(controller, { name: 'escape' });
  view = settingsViewModel(state);
  assert.equal(view.parameters[view.parameterIndex].id, 'llmTasks');
  assert.equal(view.parameters.find((item) => item.id === 'llmArchiveReview').disabled, false);
  assert.equal(view.parameters.find((item) => item.id === 'llmFailureAnalysis').disabled, false);
}));

test('legacy LLM settings migrate to the equivalent independent task selection', () => {
  const enabled = normalizeSettings({
    version: 17, llmProvider: 'ollama', llmModel: 'qwen',
    llmArchiveReview: 'patch', llmFailureAnalysis: 'same-context',
  });
  assert.equal(enabled.llmUseArchiveReview, true);
  assert.equal(enabled.llmUseSummary, true);
  assert.equal(enabled.llmUseFailedChecks, true);
  assert.equal(enabled.llmUseCommitMessage, true);
  assert.equal(enabled.llmArchiveReview, 'patch');
  assert.equal(enabled.llmFailureAnalysis, 'same-context');

  const disabled = normalizeSettings({ version: 17, llmArchiveReview: 'disabled', llmFailureAnalysis: 'disabled' });
  assert.equal(disabled.llmUseArchiveReview, false);
  assert.equal(disabled.llmUseSummary, true);
  assert.equal(disabled.llmUseFailedChecks, false);
  assert.equal(disabled.llmUseCommitMessage, true);
  assert.equal(disabled.llmArchiveReview, 'structure');
  assert.equal(disabled.llmFailureAnalysis, 'new-context');
});
