import test from 'node:test';
import assert from 'node:assert/strict';
import { themes } from 'terlio.js';
import { createInitialState } from '../src/app/state.js';
import { renderSettings } from '../src/ui/settings-view.js';
import { settingsDefinitions } from '../src/app/settings-options.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';
import { openModelConfiguration } from '../src/app/settings-model.js';

function findNode(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  for (const child of node.props?.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  for (const pane of node.props?.panes ?? []) {
    const found = findNode(pane.node, predicate);
    if (found) return found;
  }
  return null;
}

function settingsState() {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', git: true };
  state.screen = 'settings';
  state.settings = { ...DEFAULT_SETTINGS };
  const sourceArchive = settingsDefinitions(state).findIndex((item) => item.id === 'sourceArchive');
  state.settingsPanel = {
    focus: 'categories', categoryIndex: sourceArchive, parameterIndices: { sourceArchive: 0 }, choiceIndices: {},
    activeParameterId: null, subpage: null, models: [], modelsProvider: null, modelError: null,
    loadingModels: false, managedCount: 0, modal: null, modelConfig: null, storageStats: {},
    managedHistory: { paths: [], updatedAt: null },
    previous: { screen: 'home', menuItems: [], selectedIndex: 0, status: 'Ready' },
  };
  return state;
}

function wheel(node, actions) {
  node.props.onWheel({ deltaY: 1, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(actions.pop(), { type: 'settings-wheel', delta: 1, wrap: false });
}

test('every Settings list uses one-row non-wrapping wheel navigation', () => {
  const state = settingsState();
  const actions = [];
  state.dispatch = (action) => actions.push(action);

  let tree = renderSettings(state, 110, 30, themes.ocean);
  wheel(findNode(tree, (node) => node.props?.pointerId === 'zipflow:settings-categories'), actions);

  state.settingsPanel.focus = 'parameters';
  tree = renderSettings(state, 110, 30, themes.ocean);
  wheel(findNode(tree, (node) => node.props?.pointerId === 'zipflow:settings-parameters'), actions);

  state.settingsPanel.focus = 'choices';
  state.settingsPanel.activeParameterId = 'archivePolicy';
  tree = renderSettings(state, 110, 30, themes.ocean);
  wheel(findNode(tree, (node) => node.props?.pointerId === 'zipflow:settings-choices'), actions);

  const controller = { state, invalidate() {} };
  openModelConfiguration(controller, {
    id: 'gemma', key: 'gemma', label: 'Gemma', loaded: false, loadedInstanceIds: [], config: {}, maxContextLength: 32_768,
  });
  state.dispatch = (action) => actions.push(action);
  tree = renderSettings(state, 110, 30, themes.ocean);
  wheel(findNode(tree, (node) => node.props?.pointerId === 'zipflow:model-config-parameters'), actions);

  state.settingsPanel.modelConfig.focus = 'choices';
  state.settingsPanel.modelConfig.parameterIndex = 0;
  state.settingsPanel.modelConfig.activeParameterId = 'contextLength';
  tree = renderSettings(state, 110, 30, themes.ocean);
  wheel(findNode(tree, (node) => node.props?.pointerId === 'zipflow:model-config-choices'), actions);
});
