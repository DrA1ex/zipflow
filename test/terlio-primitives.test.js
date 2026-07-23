import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { themes } from 'terlio.js';
import { createInitialState } from '../src/app/state.js';
import { PathCompletionPopup } from '../src/ui/path-completion.js';
import { renderSettings } from '../src/ui/settings-view.js';

test('path completion delegates list rendering to the Terlio SelectList primitive', () => {
  const state = createInitialState();
  const actions = [];
  state.dispatch = (action) => actions.push(action);
  state.pathSuggestionActive = true;
  state.pathSuggestions = {
    selectedIndex: 0,
    items: [{ label: 'updates/', isDirectory: true }],
  };
  const node = PathCompletionPopup({ state, height: 5, theme: themes.ocean });
  assert.equal(node.type, 'selectList');
  node.props.onWheel({ deltaY: 1, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(actions, [{ type: 'path-move', delta: 1, wrap: false }]);
});

test('settings use the Terlio SplitPane primitive for the two-column layout', () => {
  const state = createInitialState();
  state.screen = 'settings';
  state.settingsPanel = {
    focus: 'categories', categoryIndex: 0, parameterIndices: {}, choiceIndices: {},
    activeParameterId: null, models: [], modelsProvider: null, modelError: null,
    loadingModels: false, managedCount: 0, modal: null, modelConfig: null,
    previous: { screen: 'home', menuItems: [], selectedIndex: 0, status: 'Ready' },
  };
  const node = renderSettings(state, 100, 24, themes.ocean);
  assert.equal(node.type, 'splitPane');
});

test('UI sources do not manually assemble rounded terminal borders', async () => {
  const sources = await Promise.all([
    'src/ui/activity.js', 'src/ui/path-completion.js', 'src/ui/settings-view.js', 'src/ui/render.js',
  ].map((file) => readFile(file, 'utf8')));
  assert.doesNotMatch(sources.join('\n'), /[╭╮╰╯]/u);
});
