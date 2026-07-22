import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renderToString, stripAnsi } from 'terlio.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { initializePlanSelections, selectedPlanCounts, selectedPlanItems } from '../src/app/plan-selection.js';
import { activateReview, handleReviewKey, showPlanReview } from '../src/app/run-review.js';
import { applyUpdatePlan } from '../src/apply/apply.js';
import { hashFile } from '../src/utils/hash.js';
import { tempDir } from '../test-support/helpers.js';
import { DEFAULT_SETTINGS, loadSettings, updateSettings } from '../src/settings/store.js';
import { beginLlmProgress } from '../src/app/llm-progress.js';
import { activateHistory, backHistory, showRunHistory } from '../src/app/history-flow.js';
import { buildRunAnalytics } from '../src/history/analytics.js';
import { autonomyConfigurationAvailable } from '../src/app/setup-autonomy.js';
import { registerSigintHandler } from '../src/index.js';
import { exportTreeItems, initializeExportTree } from '../src/app/export-tree.js';
import { renderZipflow } from '../src/ui/render.js';

function fixtureController() {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'] };
  state.workflow = { checks: [], git: { checkpoint: 'never' }, deploy: { policy: 'never' }, policy: { label: 'Practical' } };
  state.settings = { ...DEFAULT_SETTINGS };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  return { state, controller };
}

function planFixture(root = '/tmp/extracted') {
  return {
    created: [{ kind: 'created', path: 'docs/new.md', sourcePath: path.join(root, 'docs/new.md'), afterHash: 'new-hash', mode: 0o644 }],
    updated: [{ kind: 'updated', path: 'README.md', sourcePath: path.join(root, 'README.md'), beforeHash: 'old-hash', afterHash: 'next-hash', mode: 0o644 }],
    deleted: [{ kind: 'deleted', path: 'legacy.txt', beforeHash: 'legacy-hash' }],
    conflicts: [], preserved: [], skipped: [], unchanged: [], ignoredIncoming: [],
    counts: { created: 1, updated: 1, deleted: 1, conflicts: 0, preserved: 0, skipped: 0, unchanged: 0 },
  };
}

test('Review changes can keep individual added, changed, and removed paths local', async () => {
  const { state, controller } = fixtureController();
  state.run = { id: 'run-selection' };
  state.runSettings = { ...DEFAULT_SETTINGS, llmArchiveReview: 'disabled' };
  state.plan = planFixture();
  initializePlanSelections(state, state.plan);
  showPlanReview(controller);

  await activateReview(controller, 'view-plan', {});
  await activateReview(controller, 'plan-category:updated', {});
  assert.match(state.menuItems[0].label, /^\[x\] README\.md/);
  handleReviewKey(controller, { name: 'space' });
  assert.match(state.menuItems[0].label, /^\[ \] README\.md/);

  await activateReview(controller, 'plan-file:updated:0', {});
  assert.ok(state.menuItems.some((item) => item.id === 'plan-file-diff' && /View diff/.test(item.label)));
  assert.ok(state.menuItems.some((item) => item.id === 'plan-file-keep' && /Keep local version/.test(item.label)));

  const selected = selectedPlanItems(state.plan, state.decisions).map((item) => item.path);
  assert.deepEqual(selected.sort(), ['docs/new.md', 'legacy.txt']);
  assert.deepEqual(selectedPlanCounts(state.plan, state.decisions), { created: 1, updated: 0, deleted: 1 });
  assert.deepEqual(state.run.planSelections.find((item) => item.path === 'README.md'), {
    path: 'README.md', kind: 'updated', decision: 'keep',
  });
});

test('applyUpdatePlan changes only paths still selected in Review changes', async () => {
  const projectRoot = await tempDir('zipflow-selection-project-');
  const sourceRoot = await tempDir('zipflow-selection-source-');
  await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  await mkdir(path.join(sourceRoot, 'docs'), { recursive: true });
  await writeFile(path.join(projectRoot, 'README.md'), 'local readme\n');
  await writeFile(path.join(projectRoot, 'legacy.txt'), 'legacy\n');
  await writeFile(path.join(sourceRoot, 'README.md'), 'archive readme\n');
  await writeFile(path.join(sourceRoot, 'docs/new.md'), 'new docs\n');
  const plan = {
    created: [{ kind: 'created', path: 'docs/new.md', sourcePath: path.join(sourceRoot, 'docs/new.md'), afterHash: await hashFile(path.join(sourceRoot, 'docs/new.md')), mode: 0o644 }],
    updated: [{ kind: 'updated', path: 'README.md', sourcePath: path.join(sourceRoot, 'README.md'), beforeHash: await hashFile(path.join(projectRoot, 'README.md')), afterHash: await hashFile(path.join(sourceRoot, 'README.md')), mode: 0o644 }],
    deleted: [{ kind: 'deleted', path: 'legacy.txt', beforeHash: await hashFile(path.join(projectRoot, 'legacy.txt')) }],
    conflicts: [], preserved: [], skipped: [], unchanged: [], counts: {},
  };
  const decisions = new Map([['docs/new.md', 'archive'], ['README.md', 'keep'], ['legacy.txt', 'keep']]);
  const result = await applyUpdatePlan({ runId: 'selection-apply', projectPath: projectRoot, plan, decisions });

  assert.deepEqual(result.applied.map((item) => item.path), ['docs/new.md']);
  assert.equal(await readFile(path.join(projectRoot, 'README.md'), 'utf8'), 'local readme\n');
  assert.equal(await readFile(path.join(projectRoot, 'legacy.txt'), 'utf8'), 'legacy\n');
  assert.equal(await readFile(path.join(projectRoot, 'docs/new.md'), 'utf8'), 'new docs\n');
});

test('partial settings updates preserve an existing LLM token and archive policy', async () => {
  const previousHome = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-settings-103-');
  try {
    const current = { ...DEFAULT_SETTINGS, llmApiToken: 'secret-token', archivePolicy: 'move', archiveDirectory: '~/custom-archive' };
    await updateSettings(current, { allowClearToken: true, baseSettings: current });
    const staleUiState = { ...DEFAULT_SETTINGS, llmApiToken: '', archivePolicy: 'keep' };
    await updateSettings({ theme: 'mono' }, { baseSettings: staleUiState });
    const loaded = await loadSettings();
    assert.equal(loaded.llmApiToken, 'secret-token');
    assert.equal(loaded.archivePolicy, 'move');
    assert.equal(loaded.archiveDirectory, '~/custom-archive');
    assert.equal(loaded.theme, 'mono');
  } finally {
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
  }
});

test('completed LLM streaming is retained as a collapsed raw response block', () => {
  const { state, controller } = fixtureController();
  state.runSettings = { ...DEFAULT_SETTINGS, llmProvider: 'lmstudio', llmModel: 'gemma' };
  const progress = beginLlmProgress(controller);
  progress.onEvent({ type: 'chunk', chunks: 2, reasoning: 'thinking details', content: 'final model output', reasoningDelta: 'thinking', contentDelta: 'final' });
  progress.stop();

  const raw = state.messages.find((item) => item.title === 'Raw LLM response');
  assert.ok(raw);
  assert.equal(raw.collapsible, true);
  assert.equal(raw.collapsed, true);
  assert.match(raw.lines.join('\n'), /thinking details/);
  assert.match(raw.lines.join('\n'), /final model output/);
});

test('Page Down moves the active file list without scrolling Activity', async () => {
  const { state, controller } = fixtureController();
  state.screen = 'export-files';
  state.menuItems = Array.from({ length: 30 }, (_, index) => ({ id: `file-${index}`, label: `file-${index}` }));
  state.selectedIndex = 0;
  state.transcriptScroll = 17;
  await controller.handleKey({ name: 'page-down' });
  assert.ok(state.selectedIndex > 0);
  assert.equal(state.transcriptScroll, 17);
});

test('Escape from a run-history filter returns to the same filter row', async () => {
  const previousHome = process.env.ZIPFLOW_HOME;
  const projectRoot = await tempDir('zipflow-history-filter-');
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-history-filter-home-');
  try {
    const { state, controller } = fixtureController();
    state.project.root = projectRoot;
    await showRunHistory(controller);
    state.selectedIndex = 1;
    await activateHistory(controller, 'history-status-filter');
    assert.equal(state.screen, 'run-history-status-filter');
    await backHistory(controller);
    assert.equal(state.screen, 'run-history');
    assert.equal(state.selectedIndex, 1);
    assert.equal(state.menuItems[state.selectedIndex].id, 'history-status-filter');
  } finally {
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
  }
});

test('performance analytics merges LM Studio instance aliases into one model', () => {
  const analytics = buildRunAnalytics([
    { createdAt: '2026-07-21T10:00:00Z', llm: { provider: 'lmstudio', model: 'gemma', durationMs: 1000 } },
    { createdAt: '2026-07-21T11:00:00Z', llm: { provider: 'lmstudio', model: 'gemma:2.2', durationMs: 1200 } },
  ]);
  assert.equal(analytics.llm.byModel.length, 1);
  assert.equal(analytics.llm.byModel[0].count, 2);
  assert.equal(analytics.llm.byModel[0].name, 'lmstudio · gemma');
});

test('Decision mode becomes available immediately for a compatible selected instance alias', () => {
  const state = createInitialState();
  state.settings = {
    ...DEFAULT_SETTINGS,
    llmProvider: 'lmstudio',
    llmModel: 'gemma:2.2',
    llmDecisionCompatibility: { provider: 'lmstudio', model: 'gemma', supported: true },
  };
  assert.equal(autonomyConfigurationAvailable(state), true);
});

test('process SIGINT cancels an active operation and exits only when idle', async () => {
  const { controller } = fixtureController();
  const processEvents = new EventEmitter();
  const exits = [];
  controller.runtime = { exit: (code) => exits.push(code), invalidate: () => {} };
  const detach = registerSigintHandler(controller, processEvents);
  const operation = controller.beginOperation({ kind: 'checks', label: 'Running checks' });
  processEvents.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operation.signal.aborted, true);
  assert.deepEqual(exits, []);
  operation.finish();
  processEvents.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [0]);
  detach();
});

test('long notices use the adaptive scrollable help toast instead of a clipped one-line toast', () => {
  const { state, controller } = fixtureController();
  controller.toast('Long notice', 'warning', 5, Array.from({ length: 20 }, (_, index) => `Detailed line ${index + 1}`).join('\n'));
  assert.equal(state.helpToast.title, 'Long notice');
  assert.equal(state.helpToast.lines.length, 20);
  const output = stripAnsi(renderToString(renderZipflow({ state, width: 90, height: 26 }), { width: 90, height: 26 }));
  assert.match(output, /Long notice/);
  assert.ok(state.helpToast.maxScroll > 0);
  assert.doesNotMatch(output, /Detailed line 20/);
});


test('truncated context advertises full help and question mark opens the complete message', async () => {
  const { state, controller } = fixtureController();
  const full = 'This is a deliberately long explanation that cannot fit in the stable context row, but must remain available in full through contextual help without changing the panel height.';
  controller.showMenu('run-history', [{ id: 'long-help', label: 'Long item', context: full, help: full }], 'Run history');
  const output = stripAnsi(renderToString(renderZipflow({ state, width: 72, height: 22 }), { width: 72, height: 22 }));
  assert.match(output, /\[\? full help\]/);
  await controller.handleKey({ printable: true, text: '?', name: '?' });
  assert.equal(state.helpToast.lines.join(' '), full);
});

test('export tree marks navigable folders and explains safe-selection actions', () => {
  const draft = {
    paths: ['src/index.js', 'src/lib/a.js', 'README.md'],
    selectedPaths: new Set(['src/index.js', 'src/lib/a.js', 'README.md']),
    pathAnnotations: new Map(), sensitiveMap: new Map(), sensitive: [],
  };
  initializeExportTree(draft);
  const items = exportTreeItems(draft);
  const folder = items.find((item) => item.kind === 'directory');
  assert.match(folder.label, /src\/\s+›/);
  assert.match(folder.help, /Press Enter to open this folder/);
});

test('checks render known states with semantic colors while context help stays visible', () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'] };
  state.workflow = { policy: { label: 'Practical' } };
  state.screen = 'checks-running';
  state.checkRuntime = {
    checks: [
      { id: 'passed', name: 'passed' },
      { id: 'running', name: 'running' },
      { id: 'waiting', name: 'waiting' },
      { id: 'failed', name: 'failed' },
    ],
    activeIndex: 1,
    results: [{ id: 'passed', ok: true, durationMs: 10 }, { id: 'failed', ok: false, durationMs: 20 }],
  };
  const output = renderToString(renderZipflow({ state, width: 100, height: 26 }), { width: 100, height: 26 });
  assert.match(output, /PASS/);
  assert.match(output, /RUN/);
  assert.match(output, /WAIT/);
  assert.match(output, /FAIL/);
  assert.match(output, /\x1b\[[^m]+mPASS/);
  assert.match(output, /\x1b\[[^m]+mFAIL/);
});
