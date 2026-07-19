import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'terlio.js';
import { tempDir } from '../test-support/helpers.js';
import { loadSettings, saveSettings } from '../src/settings/store.js';
import { createInitialState } from '../src/app/state.js';
import { renderZipflow } from '../src/ui/render.js';

test('global settings are stored in ZIPFLOW_HOME and include a Terlio theme', async () => {
  const previous = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = await tempDir();
  try {
    await saveSettings({ theme: 'matrix', checkOutput: 'compact', llmProvider: 'ollama', llmModel: 'qwen-coder', llmLanguage: 'Russian' });
    const settings = await loadSettings();

    assert.equal(settings.theme, 'matrix');
    assert.equal(settings.checkOutput, 'compact');
    assert.equal(settings.llmProvider, 'ollama');
    assert.equal(settings.llmModel, 'qwen-coder');
    assert.equal(settings.llmLanguage, 'Russian');
  } finally {
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
  }
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
});
