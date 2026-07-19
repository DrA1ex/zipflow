import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { renderToString } from 'terlio.js';
import { tempDir } from '../test-support/helpers.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/settings/store.js';
import { createInitialState } from '../src/app/state.js';
import { renderZipflow } from '../src/ui/render.js';
import { ZipflowController } from '../src/app/controller.js';
import { openSettings, selectOption, selectSetting, submitSettingsEditor } from '../src/app/settings-panel.js';
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

test('renders the two-pane global settings panel', () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture' };
  state.screen = 'settings';
  state.settingsPanel = {
    focus: 'settings',
    settingIndex: 0,
    optionIndex: 0,
    previous: { screen: 'home', menuItems: [], selectedIndex: 0, status: 'Ready' },
  };

  const output = renderToString(renderZipflow({ state, width: 110, height: 30 }), { width: 110, height: 30 });

  assert.match(output, /SETTINGS/);
  assert.match(output, /THEME/);
  assert.match(output, /Ocean/);
  assert.match(output, /Source ZIP after a run/);
});

test('archive directory editor creates the configured folder', async () => withSettingsHome(async () => {
  const state = createInitialState();
  const project = await tempDir('zipflow-settings-project-');
  state.project = { name: 'fixture', root: project };
  state.screen = 'home';
  state.settings = { ...DEFAULT_SETTINGS, archivePolicy: 'move' };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  await openSettings(controller);

  const archiveDefinitionIndex = 4;
  await selectSetting(controller, archiveDefinitionIndex);
  assert.equal(state.settingsPanel.settingIndex, archiveDefinitionIndex);
  await selectOption(controller, 0);
  assert.equal(state.screen, 'settings-input');

  const target = path.join(await tempDir('zipflow-settings-storage-'), 'new-folder');
  state.editor.set(target);
  await submitSettingsEditor(controller);

  assert.equal(state.settings.archiveDirectory, target);
  assert.equal(await exists(target), true);
}));
