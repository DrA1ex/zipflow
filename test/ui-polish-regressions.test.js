import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createOverlayManager, renderToString, Text, themes } from 'terlio.js';
import { createInitialState, setScreen } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { backPostCheck, activatePostCheck, commitMessageCandidates } from '../src/app/run-postcheck.js';
import { ZipflowTextEditorView } from '../src/ui/editor-view.js';
import { renderZipflow } from '../src/ui/render.js';
import { renderModelReplayWorkspace } from '../src/ui/model-replay-view.js';
import { llmActivityLines } from '../src/app/llm-progress.js';
import { refreshPathSuggestions } from '../src/app/path-suggestions.js';
import { normalizeOutputArchivePath } from '../src/export/output-path.js';
import { submitExportEditor } from '../src/app/export-flow.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';
import { settingsDefinitions } from '../src/app/settings-options.js';
import { tempDir } from '../test-support/helpers.js';

function projectFixture(root = '/tmp/fixture') {
  return { name: 'fixture', root, labels: ['Node.js'], technologies: [{ id: 'node' }], checks: [], git: true };
}

function controllerFixture(root = '/tmp/fixture') {
  const state = createInitialState();
  state.project = projectFixture(root);
  state.settings = { ...DEFAULT_SETTINGS };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  return { state, controller };
}

function commitState(root = '/tmp/fixture') {
  const { state, controller } = controllerFixture(root);
  state.workflow = {
    checks: [], deploy: { policy: 'disabled' },
    git: { resultCommit: 'ask', messageStrategy: 'llm', fixedMessage: '' },
  };
  state.run = {
    id: 'run-1', archivePath: '/tmp/update.zip',
    applied: { paths: ['src/a.js'] },
    llm: { provider: 'lmstudio', model: 'gemma', commitMessage: 'feat: use local model proposal' },
  };
  state.archiveMetadata = {
    commitMessage: 'fix: use archive message',
    commitMessageSource: '.zipflow/commit-message.txt',
  };
  return { state, controller };
}

function settingsTestState() {
  const state = createInitialState();
  state.project = projectFixture();
  state.screen = 'settings';
  state.settings = { ...DEFAULT_SETTINGS, llmProvider: 'ollama', llmModel: 'qwen' };
  const localLlmIndex = settingsDefinitions(state).findIndex((item) => item.id === 'localLlm');
  state.settingsPanel = {
    focus: 'parameters', categoryIndex: localLlmIndex, parameterIndices: { localLlm: 0 }, choiceIndices: {},
    activeParameterId: null, subpage: 'llmModelTests', models: [], modelsProvider: 'ollama',
    modelError: null, loadingModels: false, managedCount: 0, modal: null, modelConfig: null,
    modelTest: { running: true, status: 'Testing connection…' }, modelTestWorkspace: null,
    previous: { screen: 'home', menuItems: [], selectedIndex: 0, status: 'Ready' },
  };
  return state;
}

test('commit prompt exposes each available message source without redundant explanatory rows', async () => {
  const { state, controller } = commitState();
  state.screen = 'commit-message';

  backPostCheck(controller);

  assert.equal(state.screen, 'commit');
  assert.deepEqual(state.panelIntro, []);
  assert.deepEqual(state.menuItems.map((item) => item.label), [
    'Create commit · Local LLM',
    'Create commit · Archive message',
    'Create commit · Generated message',
    'Edit message…',
    'Continue without commit',
  ]);
  assert.doesNotMatch(state.menuItems.map((item) => `${item.label}\n${item.description ?? ''}`).join('\n'), /Proposed source|only paths applied/i);

  await activatePostCheck(controller, 'edit-message');
  assert.equal(state.screen, 'commit-message');
  assert.equal(state.editor.value, 'feat: use local model proposal');
  assert.equal(state.editorContext.placeholder, 'Enter a commit message…');
});

test('commit candidates omit unavailable and duplicate sources', () => {
  const { state } = commitState();
  state.run.llm.commitMessage = '';
  state.archiveMetadata.commitMessage = 'zipflow: apply run-1';

  const candidates = commitMessageCandidates(state);

  assert.deepEqual(candidates.map((item) => item.id), ['metadata']);
  assert.equal(candidates[0].message, 'zipflow: apply run-1');
});

test('empty editors render a muted placeholder while keeping the cursor visible', () => {
  const output = renderToString(ZipflowTextEditorView({
    value: '', cursor: 0, placeholder: 'Enter a commit message…',
    width: 50, height: 3, lineNumbers: false, theme: themes.ocean,
  }), { width: 50, height: 5 });

  assert.match(stripAnsi(output), /Enter a commit message/);
  assert.ok(output.includes(themes.ocean.textMuted));
  assert.match(output, /\x1b\[7mE\x1b\[27m/);
});

test('active connection test is visibly blocked and muted without a disabled cross', () => {
  const state = settingsTestState();
  const output = renderToString(renderZipflow({ state, width: 100, height: 28, animationFrame: 2 }), { width: 100, height: 28 });
  const row = output.split('\n').find((line) => line.includes('Testing connection')) ?? '';

  assert.ok(row.includes(themes.ocean.textMuted));
  assert.doesNotMatch(stripAnsi(row), /×/);
});

test('streaming LLM headings use semantic colors before completion', () => {
  const lines = llmActivityLines({
    provider: 'lmstudio', model: 'gemma', label: 'Receiving the model response', elapsedMs: 1_000,
    chunks: 3, reasoning: 'Checking the changed files.', content: 'The streamed answer is arriving.',
  }, 90, themes.ocean).join('\n');

  assert.ok(lines.includes(`${themes.ocean.accent}Local LLM`));
  assert.ok(lines.includes(`${themes.ocean.textMuted}  Analysis:`));
  assert.ok(lines.includes(`${themes.ocean.accent}  Model response:`));
});

test('historical replay preview keeps choices and footer at the bottom of the modal', () => {
  const state = createInitialState();
  state.settingsPanel = { modelTestWorkspace: {
    mode: 'preview', runId: 'run-1', archiveName: 'update.zip', previewIndex: 0,
    run: { plan: { counts: { created: 1, updated: 2, deleted: 0 } } },
  } };
  const output = stripAnsi(renderToString(renderModelReplayWorkspace({
    content: Text('BACKGROUND'), state, width: 100, height: 30, theme: themes.ocean,
  }), { width: 100, height: 30 })).split('\n');
  const startLine = output.findIndex((line) => line.includes('Start replay'));
  const footerLine = output.findIndex((line) => line.includes('Enter open'));

  assert.ok(startLine >= 20, `expected choices near modal bottom, got row ${startLine}`);
  assert.ok(footerLine > startLine);
  assert.ok(footerLine >= 25, `expected footer near modal bottom, got row ${footerLine}`);
});

test('historical replay wraps long streaming output instead of losing the tail', () => {
  const state = createInitialState();
  const longOutput = `${Array.from({ length: 28 }, (_, index) => `word${index}`).join(' ')} final-token`;
  state.settingsPanel = { modelTestWorkspace: {
    mode: 'progress', runId: 'run-1', archiveName: 'update.zip', running: true,
    status: 'Receiving model response', elapsedMs: 1_000, scroll: 0, follow: true,
    unread: 0, unreadBlockIds: new Set(),
    blocks: [{ id: 'batch-1', title: 'Batch 1 of 1', lines: [], content: longOutput, reasoning: '', status: 'active', streaming: true }],
  } };

  const output = stripAnsi(renderToString(renderModelReplayWorkspace({
    content: Text('BACKGROUND'), state, width: 70, height: 24, theme: themes.ocean, animationFrame: 1,
  }), { width: 70, height: 24 }));

  assert.match(output, /final-token/);
  assert.ok(output.split('\n').filter((line) => /word\d+/.test(line)).length > 1);
});

test('context dock keeps menu geometry stable across short and long descriptions', () => {
  const state = createInitialState();
  state.project = projectFixture();
  setScreen(state, 'run-history', {
    items: [
      { id: 'short', label: 'Short run', description: 'Short context.' },
      { id: 'long', label: 'Long run', description: 'A very long selected-run explanation that must be clipped in the fixed context dock instead of changing the action pane height or moving the history list.' },
    ],
    selectedIndex: 0,
    status: 'Run history',
  });

  const first = stripAnsi(renderToString(renderZipflow({ state, width: 100, height: 24 }), { width: 100, height: 24 })).split('\n');
  state.selectedIndex = 1;
  const second = stripAnsi(renderToString(renderZipflow({ state, width: 100, height: 24 }), { width: 100, height: 24 })).split('\n');

  assert.equal(first.findIndex((line) => line.includes('Choose')), second.findIndex((line) => line.includes('Choose')));
  assert.equal(first.findIndex((line) => line.includes('RUN HISTORY')), second.findIndex((line) => line.includes('RUN HISTORY')));
  assert.equal(first.length, second.length);
});

test('output archive completion can turn a selected directory into a generated ZIP path', async () => {
  const root = await tempDir('zipflow-output-completion-');
  const projectRoot = path.join(root, 'project');
  const outputDirectory = path.join(root, 'exports');
  await mkdir(projectRoot);
  await mkdir(outputDirectory);
  const { state, controller } = controllerFixture(projectRoot);
  state.settings.lastExportDirectory = root;
  state.exportDraft = { outputPath: path.join(root, 'fixture-default.zip') };
  controller.showEditor('export-path', {
    label: 'Output ZIP path', purpose: 'export-path', placeholder: state.exportDraft.outputPath,
  }, `${outputDirectory}${path.sep}`);
  state.pathSuggestionActive = true;

  await refreshPathSuggestions(controller);
  const autoIndex = state.pathSuggestions.items.findIndex((item) => item.detail === 'AUTO');
  assert.ok(autoIndex >= 0);
  state.pathSuggestions.selectedIndex = autoIndex;
  await controller.handleKey({ name: 'tab' });

  assert.equal(path.dirname(state.editor.value), outputDirectory);
  assert.equal(path.basename(state.editor.value), 'fixture-default.zip');
  assert.equal(state.pathSuggestions, null);
});

test('output archive path adds the ZIP extension and confirms replacement separately', async () => {
  const root = await tempDir('zipflow-output-normalize-');
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot);
  const normalized = await normalizeOutputArchivePath(path.join(root, 'release'), {
    cwd: root, project: projectFixture(projectRoot), settings: {}, currentDefault: path.join(root, 'fixture.zip'),
  });
  assert.equal(normalized, path.join(root, 'release.zip'));

  const existing = path.join(root, 'existing.zip');
  await writeFile(existing, 'old archive');
  const { state, controller } = controllerFixture(projectRoot);
  state.exportDraft = { outputPath: path.join(root, 'default.zip') };
  controller.showEditor('export-path', { label: 'Output ZIP path', purpose: 'export-path' }, existing);

  await submitExportEditor(controller);

  assert.equal(state.screen, 'export-overwrite');
  assert.equal(state.exportDraft.pendingOutputPath, existing);
  assert.deepEqual(state.menuItems.map((item) => item.label), ['Replace existing archive', 'Choose another path']);
});

test('context help prefers short context and keeps detailed help available', () => {
  const { state, controller } = controllerFixture();
  setScreen(state, 'home', {
    items: [{ id: 'one', label: 'Action', context: 'Short context.', description: 'Legacy description.', help: 'Long detailed explanation.' }],
    selectedIndex: 0,
  });

  state.overlays = createOverlayManager();
  controller.showContextHelp();

  const overlay = state.overlays.top();
  assert.equal(overlay.type, 'help');
  const rendered = stripAnsi(renderToString(renderZipflow({ state, width: 76, height: 24 }), { width: 76, height: 24 }));
  assert.match(rendered, /Short context/);
  assert.match(rendered, /Long detailed explanation/);
});


test('context help renders structured performance statistics instead of the short menu hint', () => {
  const { state, controller } = controllerFixture();
  setScreen(state, 'run-analytics', {
    items: [{
      id: 'analytics:checks-total',
      label: 'Checks overall · 12 runs',
      description: 'median 3.2s · average 3.8s',
      helpTitle: 'Performance analytics',
      helpLines: [
        'Overview',
        'Recorded runs: 12',
        '',
        'Timing',
        'Median: 3.2s',
        'Average: 3.8s',
        '',
        'Reliability',
        'Success rate: 92%',
      ],
    }],
    selectedIndex: 0,
  });

  state.overlays = createOverlayManager();
  controller.showContextHelp();

  const rendered = stripAnsi(renderToString(renderZipflow({ state, width: 76, height: 24 }), { width: 76, height: 24 }));
  assert.match(rendered, /Performance analytics/);
  assert.match(rendered, /Overview/);
  assert.match(rendered, /Recorded runs: 12/);
  assert.match(rendered, /Timing/);
  assert.match(rendered, /Median: 3.2s/);
  assert.match(rendered, /Success rate: 92%/);
  assert.doesNotMatch(rendered, /Help · Checks overall/);
});

function stripAnsi(value) {
  return String(value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}
