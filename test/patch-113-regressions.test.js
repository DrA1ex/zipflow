import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayManager, renderToString, stripAnsi } from 'terlio.js';
import { appendMessage, createInitialState, setScreen } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { renderZipflow } from '../src/ui/render.js';
import { WHEEL_SCROLL_ROWS, wheelScrollDelta } from '../src/ui/wheel.js';
import { zipflowToastWidth } from '../src/ui/toast-overlay.js';
import { settingsDefinitions, settingsPageSummary } from '../src/app/settings-options.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';

function projectFixture() {
  return { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], technologies: [{ id: 'node' }], checks: [], git: true };
}

function findNode(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  for (const pane of node.props?.panes ?? []) {
    const found = findNode(pane.node, predicate);
    if (found) return found;
  }
  return null;
}

function event(deltaY) {
  return { deltaY, preventDefault() {}, stopPropagation() {} };
}

test('mouse wheel movement is normalized to exactly one row in either direction', () => {
  assert.equal(WHEEL_SCROLL_ROWS, 1);
  assert.equal(wheelScrollDelta({ deltaY: 0.1 }), 1);
  assert.equal(wheelScrollDelta({ deltaY: 120 }), 1);
  assert.equal(wheelScrollDelta({ deltaY: -0.1 }), -1);
  assert.equal(wheelScrollDelta({ deltaY: -120 }), -1);
  assert.equal(wheelScrollDelta({ deltaY: 0 }), 0);
});

test('menu, Activity, and Settings wheel handlers all use the one-row contract', () => {
  const menuState = createInitialState();
  menuState.project = projectFixture();
  menuState.workflow = { checks: [], policy: { label: 'Practical' } };
  const menuActions = [];
  menuState.dispatch = (action) => menuActions.push(action);
  setScreen(menuState, 'home', {
    items: Array.from({ length: 12 }, (_, index) => ({ id: `item-${index}`, label: `Item ${index}` })),
    status: 'Ready',
  });
  const menuTree = renderZipflow({ state: menuState, width: 100, height: 28 });
  findNode(menuTree, (node) => node.props?.pointerId === 'zipflow:menu').props.onWheel(event(1));
  assert.deepEqual(menuActions.pop(), { type: 'menu-move-selection', delta: 1, wrap: false });

  const activityState = createInitialState();
  activityState.project = projectFixture();
  activityState.workflow = { checks: [], policy: { label: 'Practical' } };
  for (let index = 0; index < 20; index += 1) appendMessage(activityState, `Message ${index}`, ['line one', 'line two'], 'info', { collapsible: false });
  activityState.transcriptSticky = false;
  activityState.transcriptScroll = 9;
  const activityTree = renderZipflow({ state: activityState, width: 100, height: 28 });
  findNode(activityTree, (node) => node.props?.pointerId === 'zipflow:transcript').props.onWheel(event(-1));
  assert.equal(activityState.transcriptScroll, 8);

  const settingsState = createInitialState();
  settingsState.project = projectFixture();
  settingsState.screen = 'settings';
  settingsState.settings = { ...DEFAULT_SETTINGS };
  const sourceArchiveIndex = settingsDefinitions(settingsState).findIndex((item) => item.id === 'sourceArchive');
  settingsState.settingsPanel = {
    focus: 'parameters', categoryIndex: sourceArchiveIndex, parameterIndices: { sourceArchive: 0 }, choiceIndices: {},
    activeParameterId: null, subpage: null, models: [], modelsProvider: null, modelError: null, loadingModels: false,
    managedCount: 0, modal: null, modelConfig: null, storageStats: {}, managedHistory: { paths: [], updatedAt: null },
    previous: { screen: 'home', menuItems: [], selectedIndex: 0, status: 'Ready' },
  };
  const settingsActions = [];
  settingsState.dispatch = (action) => settingsActions.push(action);
  const settingsTree = renderZipflow({ state: settingsState, width: 110, height: 30 });
  findNode(settingsTree, (node) => node.props?.pointerId === 'zipflow:settings-parameters').props.onWheel(event(1));
  assert.deepEqual(settingsActions.pop(), { type: 'settings-wheel', delta: 1, wrap: false });
});

test('menu paging and wheel movement keep selection valid at disabled boundaries', async () => {
  const state = createInitialState();
  state.menuItems = [
    { id: 'empty', label: 'No changed files recorded', disabled: true },
    { id: 'back', label: 'Back to run details' },
  ];
  state.selectedIndex = 1;
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  controller.pageSelection(-1);
  assert.equal(state.selectedIndex, 1);

  await controller.dispatch({ type: 'menu-move-selection', delta: 1, wrap: false });
  assert.equal(state.selectedIndex, 1);
  assert.ok(state.selectedIndex >= 0 && state.selectedIndex < state.menuItems.length);
  assert.equal(state.menuItems[state.selectedIndex].disabled, undefined);
});

test('Zipflow toasts auto-size and wrap all detail text instead of clipping it', () => {
  assert.ok(zipflowToastWidth([{ message: 'Saved' }], 100) < zipflowToastWidth([{
    message: 'A much longer notification title that needs additional room',
  }], 100));

  const state = createInitialState();
  state.project = projectFixture();
  state.workflow = { checks: [], policy: { label: 'Practical' } };
  state.overlays = createOverlayManager();
  state.overlays.toast(
    'Long notice',
    'warning',
    5,
    'This detail must wrap over several physical rows and preserve the final marker FINAL_TOKEN.',
  );
  const output = stripAnsi(renderToString(renderZipflow({ state, width: 58, height: 24 }), { width: 58, height: 24 }));
  assert.match(output, /Long notice/);
  assert.match(output, /FINAL_TOKEN/);
  const detailRows = output.split('\n').filter((line) => /This detail|physical rows|FINAL_TOKEN/.test(line));
  assert.ok(detailRows.length >= 2, output);
});

test('archive, backup, and managed-history statistics remain visible and localized', () => {
  const state = createInitialState();
  state.project = projectFixture();
  state.settings = { ...DEFAULT_SETTINGS, interfaceLanguage: 'ru' };
  state.i18n = { languageId: 'ru', available: [] };
  state.settingsPanel = {
    loadingStorage: false,
    storageStats: {
      archives: { count: 4, totalBytes: 2_048, oldestAt: '2026-01-02T00:00:00.000Z' },
      backups: { count: 3, fileCount: 17, totalBytes: 4_096, oldestAt: '2026-01-03T00:00:00.000Z' },
    },
    managedHistory: { paths: ['a', 'b', 'c'], updatedAt: '2026-01-04T00:00:00.000Z' },
  };
  const definitions = settingsDefinitions(state);
  const source = settingsPageSummary(state, definitions.find((item) => item.id === 'sourceArchive')).join('\n');
  const backups = settingsPageSummary(state, definitions.find((item) => item.id === 'backups')).join('\n');
  const history = settingsPageSummary(state, definitions.find((item) => item.id === 'managedHistory')).join('\n');
  assert.match(source, /Архивов: 4/);
  assert.match(source, /самый старый:/);
  assert.match(backups, /Резервных копий: 3/);
  assert.match(backups, /файлов: 17/);
  assert.match(history, /Записанных путей: 3/);
  assert.match(history, /последнее обновление:/);
});
