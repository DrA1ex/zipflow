import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString, Text, themes } from 'terlio.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { beginArchiveInput } from '../src/app/run-flow.js';
import { renderZipflow } from '../src/ui/render.js';
import { renderModelReplayWorkspace } from '../src/ui/model-replay-view.js';
import {
  followReplayLatest, handleModelReplayWorkspaceKey, scrollReplayWorkspace,
  startHistoricalModelReplay, updateReplayWorkspace,
} from '../src/app/settings-model-replay.js';
import { beginCreateZip, activateExport } from '../src/app/export-flow.js';
import { activateChecks, showChecksStep } from '../src/app/setup-checks.js';
import { settingsDefinitions, settingsParameters } from '../src/app/settings-options.js';
import { openModelConfiguration } from '../src/app/settings-model.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';
import { llmActivityLines, updateLlmProgress } from '../src/app/llm-progress.js';
import { formatRunReport } from '../src/runs/text-report.js';
import { tempDir, writeFiles } from '../test-support/helpers.js';

function projectFixture(root = '/tmp/fixture') {
  return { name: 'fixture', root, labels: ['Node.js'], technologies: [{ id: 'node' }], checks: [], git: false };
}

function settingsState() {
  const state = createInitialState();
  state.project = projectFixture();
  state.screen = 'settings';
  state.settings = { ...DEFAULT_SETTINGS, llmProvider: 'ollama', llmModel: 'qwen' };
  state.settingsPanel = {
    focus: 'parameters', categoryIndex: 2, parameterIndices: { localLlm: 0 }, choiceIndices: {},
    activeParameterId: null, subpage: 'llmModelTests', models: [], modelsProvider: 'ollama',
    modelError: null, loadingModels: false, managedCount: 0, modal: null, modelConfig: null,
    modelTest: { running: true, status: 'Testing connection…' }, modelTestWorkspace: null,
    previous: { screen: 'home', menuItems: [], selectedIndex: 0, status: 'Ready' },
  };
  return state;
}

test('archive input starts with one concise instruction', () => {
  const state = createInitialState();
  state.project = projectFixture();
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  beginArchiveInput(controller);

  assert.deepEqual(state.editorContext.instructions, ['Drop a ZIP file into the terminal or enter its path.']);
  assert.doesNotMatch(state.editorContext.instructions.join('\n'), /Recent|Next:|Tab|patch/i);
});

test('Terlio animation frames advance active model operations without a disabled suffix', () => {
  const state = settingsState();
  const first = stripAnsi(renderToString(renderZipflow({ state, width: 100, height: 28, animationFrame: 0 }), { width: 100, height: 28 }));
  const second = stripAnsi(renderToString(renderZipflow({ state, width: 100, height: 28, animationFrame: 1 }), { width: 100, height: 28 }));
  assert.notEqual(first, second);
  assert.match(second, /Testing connection/);
  assert.doesNotMatch(second, /Testing connection…\s+×|Testing connection ×/);
});


test('model Save and select loader animates while configuration is being applied', () => {
  const state = settingsState();
  state.settingsPanel.subpage = null;
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  openModelConfiguration(controller, {
    id: 'gemma', key: 'gemma', label: 'Gemma', loaded: false, loadedInstanceIds: [], config: {}, maxContextLength: 32_768,
  });
  state.settingsPanel.modelConfig.loading = true;
  state.settingsPanel.modelConfig.progressLabel = 'Loading Gemma…';

  const first = stripAnsi(renderToString(renderZipflow({ state, width: 100, height: 28, animationFrame: 0 }), { width: 100, height: 28 }));
  const second = stripAnsi(renderToString(renderZipflow({ state, width: 100, height: 28, animationFrame: 1 }), { width: 100, height: 28 }));
  assert.notEqual(first, second);
  assert.match(second, /Loading Gemma/);
  assert.doesNotMatch(second, /Loading Gemma…\s+×|Loading Gemma ×/);
});

test('historical replay opens as a dimmed preview and does not start automatically', () => {
  const state = settingsState();
  state.settingsPanel.replayRuns = [{
    id: 'run-1', archivePath: '/tmp/update.zip', replayAvailable: true,
    plan: { counts: { created: 1, updated: 2, deleted: 0 } },
  }];
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  assert.equal(startHistoricalModelReplay(controller, 'run-1'), true);
  const workspace = state.settingsPanel.modelTestWorkspace;
  assert.equal(workspace.mode, 'preview');
  assert.equal(workspace.running, false);
  assert.equal(workspace.blocks.length, 0);

  const tree = renderModelReplayWorkspace({ content: Text('BACKGROUND'), state, width: 100, height: 30, theme: themes.ocean });
  assert.equal(tree.type, 'overlayHost');
  assert.equal(tree.props.dim, true);
  const modalText = stripAnsi(renderToString(tree, { width: 100, height: 30 }));
  assert.match(modalText, /Start replay/);
  const compactModal = modalText.replace(/\s+/g, ' ');
  assert.match(compactModal, /No project files, Git state, backups, source archives, or run history will be/);
  assert.match(compactModal, /changed/);
});

test('historical replay preserves manual scrolling and exposes a latest-output indicator', async () => {
  const state = settingsState();
  state.settingsPanel.modelTestWorkspace = {
    mode: 'progress', runId: 'run-1', running: true, status: 'Streaming', elapsedMs: 1_000,
    blocks: Array.from({ length: 18 }, (_, index) => ({
      id: `old-${index}`, title: `Old block ${index}`, lines: ['line'], content: '', reasoning: '', status: 'done', streaming: false,
    })),
    scroll: 10, maxScroll: 20, follow: false, unread: 0, unreadBlockIds: new Set(),
  };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  const workspace = state.settingsPanel.modelTestWorkspace;

  updateReplayWorkspace(controller, { type: 'batch-start', index: 1, total: 2, files: ['src/a.js'] });
  assert.equal(workspace.scroll, 10);
  assert.equal(workspace.follow, false);
  assert.equal(workspace.unread, 1);

  await handleModelReplayWorkspaceKey(controller, { name: 'page-down' });
  assert.equal(workspace.scroll, 18);
  await handleModelReplayWorkspaceKey(controller, { name: 'up' });
  assert.equal(workspace.scroll, 17);
  followReplayLatest(workspace);
  assert.equal(workspace.scroll, 20);
  assert.equal(workspace.unread, 0);

  scrollReplayWorkspace(workspace, -3);
  updateReplayWorkspace(controller, { type: 'phase', phase: 'synthesis', label: 'Synthesizing result' });
  const tree = renderModelReplayWorkspace({ content: Text('BACKGROUND'), state, width: 100, height: 24, theme: themes.ocean });
  const top = tree.props.manager.top().node;
  const wheelRegion = findNode(top, (node) => node.props?.pointerId === 'zipflow:model-replay-workspace');
  assert.ok(wheelRegion?.props?.onWheel);
  const before = workspace.scroll;
  wheelRegion.props.onWheel({ deltaY: -1, preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(workspace.scroll < before);
  const output = stripAnsi(renderToString(tree, { width: 100, height: 24 }));
  assert.match(output, /new replay block/);
});


test('workflow check toggles keep focus on the same checkbox', () => {
  const state = createInitialState();
  state.draft = {
    checks: [
      { id: 'test', name: 'Tests', description: 'Run tests', type: 'test', selected: true },
      { id: 'lint', name: 'Lint', description: 'Run lint', type: 'lint', selected: false },
    ],
  };
  state.setupEditing = true;
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  showChecksStep(controller, 1);

  activateChecks(controller, 'check:1', () => {});

  assert.equal(state.draft.checks[1].selected, true);
  assert.equal(state.selectedIndex, 1);
  assert.equal(state.menuItems[state.selectedIndex].id, 'check:1');
});

test('storage settings are separate focused categories without selectable section rows', () => {
  const state = settingsState();
  state.settingsPanel.storageStats = {
    archives: { count: 2, bytes: 100, oldestAt: '2026-01-01', directory: '/tmp/archives' },
    backups: { count: 3, bytes: 200, files: 8, oldestAt: '2026-01-02', directory: '/tmp/backups' },
  };
  const definitions = settingsDefinitions(state);
  assert.ok(definitions.some((item) => item.id === 'sourceArchive'));
  assert.ok(definitions.some((item) => item.id === 'backups'));
  assert.ok(definitions.some((item) => item.id === 'managedHistory'));
  for (const id of ['sourceArchive', 'backups', 'managedHistory']) {
    const parameters = settingsParameters(state, definitions.find((item) => item.id === id));
    assert.equal(parameters.some((item) => item.type === 'section' || item.type === 'stat'), false);
  }
});

test('custom ZIP selection excludes ignored, sensitive, and protected paths by default', async () => {
  const root = await tempDir('zipflow-custom-tree-');
  await writeFiles(root, {
    '.gitignore': 'ignored/\n',
    '.env': 'TOKEN=secret\n',
    '.git/config': '[core]\n',
    '.zipflow/state.json': '{}\n',
    'ignored/cache.txt': 'cache\n',
    'src/a.js': 'a\n',
    'src/b.js': 'b\n',
    'README.md': 'safe\n',
  });
  const state = createInitialState();
  state.project = projectFixture(root);
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  beginCreateZip(controller);
  await activateExport(controller, 'export-interactive');

  assert.equal(state.screen, 'export-files');
  assert.equal(state.exportDraft.selectedPaths.has('README.md'), true);
  assert.equal(state.exportDraft.selectedPaths.has('src/a.js'), true);
  assert.equal(state.exportDraft.selectedPaths.has('.env'), false);
  assert.equal(state.exportDraft.selectedPaths.has('ignored/cache.txt'), false);
  assert.equal(state.exportDraft.selectedPaths.has('.git/config'), false);
  assert.equal(state.exportDraft.selectedPaths.has('.zipflow/state.json'), false);

  const srcId = `export-tree-directory:${encodeURIComponent('src')}`;
  state.selectedIndex = state.menuItems.findIndex((item) => item.id === srcId);
  await controller.handleKey({ name: 'space' });
  assert.equal(state.exportDraft.selectedPaths.has('src/a.js'), false);
  await activateExport(controller, srcId);
  const childId = `export-tree-file:${encodeURIComponent('src/a.js')}`;
  await activateExport(controller, childId);
  await controller.handleKey({ name: 'left' });
  assert.match(stripAnsi(state.menuItems.find((item) => item.id === srcId).label), /\[■\]/);
});

test('bounded LLM coverage remains visible during capped batches', () => {
  const state = createInitialState();
  state.llmRuntime = {
    provider: 'lmstudio', model: 'gemma', elapsedMs: 0, chunks: 0,
    label: '', deliveryMode: null, reasoning: '', content: '',
  };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  updateLlmProgress(controller, { type: 'delivery-mode', requestedMode: 'adaptive', deliveryMode: 'capped' });
  updateLlmProgress(controller, {
    type: 'coverage', reviewedFiles: 12, totalFiles: 84, manifestFiles: 84, omittedFiles: 72, patchCoveragePercent: 31,
  });
  updateLlmProgress(controller, { type: 'batch-start', index: 1, total: 3, files: ['src/a.js'] });

  assert.equal(state.llmRuntime.deliveryMode, 'capped');
  const lines = llmActivityLines(state.llmRuntime, 100).join('\n');
  assert.match(lines, /Coverage: 12 of 84 files with content/);
  assert.match(lines, /Patch coverage: 31%/);

  const report = formatRunReport({
    id: 'run-coverage', projectPath: '/tmp/project', archivePath: '/tmp/update.zip',
    status: 'completed', createdAt: '2026-07-20T00:00:00Z',
    llm: {
      provider: 'lmstudio', model: 'gemma', summary: ['Reviewed representative changes.'],
      delivery: { resolved: 'capped', batches: 3, coverage: state.llmRuntime.coverage },
    },
  });
  assert.match(report, /LLM content coverage: 12 of 84 changed files/);
  assert.match(report, /LLM manifest coverage: 84 of 84 changed paths/);
});

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null;
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

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '');
}
