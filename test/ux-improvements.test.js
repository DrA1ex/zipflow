import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createOverlayManager, renderToString } from 'terlio.js';
import { createInitialState, appendMessage, refreshMenuSearch, replaceLastMessage, setScreen } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { captureRunSettings, activeRunSettings } from '../src/app/runtime-settings.js';
import { inspectPotentiallySensitivePaths } from '../src/export/sensitive.js';
import { beginCreateZip, activateExport } from '../src/app/export-flow.js';
import { beginArchiveInput } from '../src/app/run-flow.js';
import { renderZipflow } from '../src/ui/render.js';
import { runStep } from '../src/ui/format.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';
import { testSelectedModel } from '../src/app/settings-model-check.js';
import { activateRollback, showRunDetails } from '../src/app/run-rollback.js';
import { tempDir, writeFiles } from '../test-support/helpers.js';

function projectFixture(root = '/tmp/fixture') {
  return { name: 'fixture', root, labels: ['Node.js'], technologies: [{ id: 'node' }], checks: [], git: true };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function findNode(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

test('active runs use an immutable settings snapshot while global settings can change', () => {
  const state = createInitialState();
  state.settings = {
    ...DEFAULT_SETTINGS,
    llmProvider: 'ollama', llmModel: 'model-a', llmArchiveReview: 'patch', llmApiToken: 'secret',
  };
  state.run = { id: 'run-1', status: 'planned' };

  const snapshot = captureRunSettings(state);
  state.settings = { ...state.settings, llmModel: 'model-b', llmArchiveReview: 'disabled' };

  assert.equal(activeRunSettings(state), snapshot);
  assert.equal(activeRunSettings(state).llmModel, 'model-a');
  assert.equal(activeRunSettings(state).llmArchiveReview, 'patch');
  assert.equal(state.run.settings.llmApiToken, '[configured]');
  assert.throws(() => { snapshot.llmModel = 'mutated'; }, TypeError);
});

test('Activity keeps the reading position and counts only newly appended entries', () => {
  const state = createInitialState();
  state.transcriptSticky = false;
  state.transcriptScroll = 4;

  appendMessage(state, 'First new entry', ['one']);
  replaceLastMessage(state, 'First new entry', ['one', 'updated']);
  appendMessage(state, 'Second new entry', ['two']);

  assert.equal(state.transcriptScroll, 4);
  assert.equal(state.transcriptSticky, false);
  assert.equal(state.activityUnread, 2);
});

test('menu search filters by label, description, and search text while preserving selection by id', () => {
  const state = createInitialState();
  setScreen(state, 'run-history', {
    items: [
      { id: 'alpha', label: 'Completed', description: 'release.zip', searchText: 'run-a abc123' },
      { id: 'beta', label: 'Failed', description: 'update.zip', searchText: 'run-b def456' },
    ],
    selectedIndex: 1,
  });
  state.menuSearch = { screen: 'run-history', active: true, query: '' };

  refreshMenuSearch(state, 'def456');

  assert.deepEqual(state.menuItems.map((item) => item.id), ['beta']);
  assert.equal(state.selectedIndex, 0);
  refreshMenuSearch(state, '');
  assert.deepEqual(state.menuItems.map((item) => item.id), ['alpha', 'beta']);
  assert.equal(state.menuItems[state.selectedIndex].id, 'beta');
});

test('Create ZIP pauses for a safety review and can exclude flagged files', async () => {
  const root = await tempDir('zipflow-sensitive-export-');
  await writeFiles(root, { '.env': 'TOKEN=secret\n', 'README.md': 'safe\n' });
  const state = createInitialState();
  state.project = projectFixture(root);
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  beginCreateZip(controller);
  await activateExport(controller, 'export-all');

  assert.equal(state.screen, 'export-sensitive');
  assert.ok(state.exportDraft.sensitive.some((item) => item.path === '.env'));
  await activateExport(controller, 'export-sensitive-exclude');
  assert.equal(state.screen, 'export-preview');
  assert.equal(state.exportDraft.selectedPaths.has('.env'), false);
  assert.equal(state.exportDraft.selectedPaths.has('README.md'), true);
});

test('sensitive path inspection avoids common template false positives', () => {
  const records = inspectPotentiallySensitivePaths([
    '.env', '.env.example', 'config/credentials.json', 'fixtures/credentials.sample.json',
    'private-key.pem', 'data/local.sqlite', 'dist/app.js',
  ]);
  const paths = records.map((item) => item.path);

  assert.ok(paths.includes('.env'));
  assert.ok(paths.includes('config/credentials.json'));
  assert.ok(paths.includes('private-key.pem'));
  assert.ok(paths.includes('data/local.sqlite'));
  assert.ok(paths.includes('dist/app.js'));
  assert.equal(paths.includes('.env.example'), false);
  assert.equal(paths.includes('fixtures/credentials.sample.json'), false);
});

test('context help uses a blocking Terlio help overlay and never adds an Activity entry', () => {
  const state = createInitialState();
  state.project = projectFixture();
  const longHelp = Array.from({ length: 30 }, (_, index) => `Detailed help line ${index + 1}`).join(' ');
  setScreen(state, 'home', { items: [{ id: 'action', label: 'Action', description: longHelp }], status: 'Ready' });
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  state.overlays = createOverlayManager();

  controller.showContextHelp();
  assert.equal(state.messages.length, 0);
  assert.equal(state.overlays.top().type, 'help');
  const output = renderToString(renderZipflow({ state, width: 60, height: 20 }), { width: 60, height: 20 });
  assert.match(output, /Help · Action/);
  assert.doesNotMatch(output, /PgUp|PgDn|page-up|page-down/i);
  const firstRender = state.overlays.top().render({ width: 58, height: 8 });
  const firstHelpOutput = renderToString(firstRender, { width: 58, height: 8 });
  const wheelRegion = findNode(firstRender, (node) => node.props?.pointerId === 'zipflow:help-overlay');
  assert.ok(wheelRegion?.props?.onWheel);
  wheelRegion.props.onWheel({ deltaY: 1, preventDefault() {}, stopPropagation() {} });
  const secondRender = state.overlays.top().render({ width: 58, height: 8 });
  const secondHelpOutput = renderToString(secondRender, { width: 58, height: 8 });
  assert.notEqual(secondHelpOutput, firstHelpOutput);
  state.overlays.handleKey({ name: 'escape' });
  assert.equal(state.overlays.top(), null);
});

test('empty archive input exposes existing recent archives only after explicit Tab', async () => {
  const archive = path.join(await tempDir('zipflow-recent-archive-'), 'recent.zip');
  await writeFile(archive, 'zip placeholder');
  const state = createInitialState();
  state.project = projectFixture();
  state.settings = { ...DEFAULT_SETTINGS, recentArchivePaths: [archive, '/missing/archive.zip'] };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  beginArchiveInput(controller);
  assert.equal(state.pathSuggestions, null);
  await controller.handleKey({ name: 'tab' });

  assert.deepEqual(state.pathSuggestions.items.map((item) => item.insert), [archive]);
  assert.equal(state.pathSuggestionActive, true);
});

test('active-run settings guidance is confined to the footer while Settings is open', () => {
  const state = createInitialState();
  state.project = projectFixture();
  state.run = { id: 'run-1', status: 'planned' };
  state.settings = { ...DEFAULT_SETTINGS, llmProvider: 'ollama', llmModel: 'model-a', llmArchiveReview: 'structure' };
  captureRunSettings(state);
  state.screen = 'settings';
  state.status = 'Global settings';
  state.settingsPanel = {
    focus: 'categories', categoryIndex: 0, parameterIndices: {}, choiceIndices: {}, activeParameterId: null,
    models: [], modelsProvider: null, modelError: null, loadingModels: false, managedCount: 0,
    modal: null, modelConfig: null, choiceSearch: null,
    previous: { screen: 'plan-review', menuItems: [], selectedIndex: 0, status: 'Review update plan' },
  };

  const settingsOutput = renderToString(renderZipflow({ state, width: 120, height: 30 }), { width: 120, height: 30 });
  assert.match(settingsOutput, /Current Ollama\/model-a · Structure · edits → next run/);

  setScreen(state, 'plan-review', { items: [{ id: 'apply', label: 'Apply update' }], status: 'Review update plan' });
  const runOutput = renderToString(renderZipflow({ state, width: 120, height: 30 }), { width: 120, height: 30 });
  assert.doesNotMatch(runOutput, /edits → next run/);
});

test('action lists show only the selected action description', () => {
  const state = createInitialState();
  state.project = projectFixture();
  setScreen(state, 'home', {
    items: [
      { id: 'first', label: 'First action', description: 'Description visible for first action' },
      { id: 'second', label: 'Second action', description: 'Description hidden for second action' },
    ],
    selectedIndex: 0,
    status: 'Ready',
  });

  const output = renderToString(renderZipflow({ state, width: 100, height: 24 }), { width: 100, height: 24 });
  assert.match(output, /Description visible for first action/);
  assert.doesNotMatch(output, /Description hidden for second action/);
});

test('commit and deployment screens use the Verify stage', () => {
  for (const screen of ['checks-running', 'commit', 'deploy-prompt', 'deploy-running']) {
    const state = createInitialState();
    state.run = { id: 'run-1' };
    state.screen = screen;
    assert.deepEqual(runStep(state), { number: 4, label: 'Verify', screens: ['checks-running', 'check-failed', 'commit-message', 'commit', 'deploy-prompt', 'deploy-running', 'deploy-failed'] });
  }
});

test('selected model compatibility test validates metadata and the Zipflow text protocol', async () => {
  const originalFetch = globalThis.fetch;
  const toasts = [];
  try {
    let chatCalls = 0;
    globalThis.fetch = async (url) => {
      if (url.endsWith('/api/v1/models')) return jsonResponse({
        models: [{
          type: 'llm', key: 'gemma', max_context_length: 32_768,
          loaded_instances: [{ id: 'gemma-loaded', config: { context_length: 16_384 } }],
          capabilities: { reasoning: { allowed_options: ['off'] } },
        }],
      });
      if (url.endsWith('/api/v1/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) return jsonResponse({
          output: [{ type: 'message', content: 'SUMMARY:\n- Model connection works.\nCOMMIT MESSAGE:\nTest local model compatibility' }],
        });
        return jsonResponse({
          output: [{ type: 'message', content: JSON.stringify({
            schemaVersion: 1, gate: 'compatibility-decision', action: 'continue', targetId: null,
            confidence: 1, summary: 'Autonomous decision protocol works.', evidence: [], risks: [], conditions: [],
          }) }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const state = createInitialState();
    state.settings = {
      ...DEFAULT_SETTINGS,
      llmProvider: 'lmstudio', llmModel: 'gemma', llmArchiveReview: 'disabled', llmApiToken: 'token',
    };
    state.settingsPanel = {};
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};
    controller.attachRuntime({ overlays: { toast: (...args) => toasts.push(args) } });

    const ok = await testSelectedModel(controller);

    assert.equal(ok, true);
    assert.equal(state.settingsPanel.modelTest.status, 'passed');
    assert.equal(state.settingsPanel.modelTest.contextLength, 16_384);
    assert.equal(state.settingsPanel.modelTest.autonomousDecisionProtocol, true);
    assert.equal(state.settings.llmDecisionCompatibility.supported, true);
    assert.ok(toasts.some(([message, level]) => message === 'Model test passed' && level === 'success'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete stored diff supports next and previous file navigation', async () => {
  const root = await tempDir('zipflow-diff-workspace-');
  const patchPath = path.join(root, 'changes.patch');
  await writeFile(patchPath, [
    'diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-a', '+A',
    'diff --git a/b.txt b/b.txt', '--- a/b.txt', '+++ b/b.txt', '@@ -1 +1 @@', '-b', '+B', '',
  ].join('\n'));
  const state = createInitialState();
  state.project = projectFixture(root);
  state.run = {
    id: 'run-1', status: 'completed', projectPath: root, archivePath: '/tmp/update.zip',
    plan: { counts: { created: 0, updated: 2, deleted: 0, unchanged: 0, skipped: 0, preserved: 0, conflicts: 0 }, created: [], updated: ['a.txt', 'b.txt'], deleted: [] },
    patch: { path: patchPath }, decisions: [],
  };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  showRunDetails(controller, state.run, { origin: 'history' });
  await activateRollback(controller, 'view-run-diff');
  assert.equal(state.diffView.diff.path, 'a.txt');

  await controller.handleKey({ name: 'j', text: 'j', printable: true });
  await waitFor(() => state.diffView.diff.path === 'b.txt');
  await controller.handleKey({ name: 'k', text: 'k', printable: true });
  await waitFor(() => state.diffView.diff.path === 'a.txt');
});


test('collapsed Activity blocks use their semantic summary instead of arbitrary first lines', () => {
  const state = createInitialState();
  appendMessage(state, 'Checks', ['Installing dependencies', 'Many more details'], 'success', {
    collapsible: true,
    collapsed: true,
    collapsedSummary: 'Checks · 5/5 passed · 18.4s',
  });
  const output = renderToString(renderZipflow({ state, width: 100, height: 24 }), { width: 100, height: 24 });
  assert.match(output, /Checks · 5\/5 passed · 18\.4s/);
  assert.doesNotMatch(output, /Installing dependencies/);
});

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous UI state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
