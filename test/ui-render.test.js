import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString, themes } from 'terlio.js';
import { createInitialState, appendMessage, setScreen } from '../src/app/state.js';
import { renderZipflow } from '../src/ui/render.js';
import { transcriptLines } from '../src/ui/activity.js';
import { ZipflowController } from '../src/app/controller.js';
import { ZIPFLOW_VERSION } from '../src/version.js';
import { projectSummary } from '../src/ui/format.js';

test('renders the interactive project home without layout errors', () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], git: true };
  state.workflow = { policy: { label: 'Practical' } };
  appendMessage(state, 'Project detected', ['/tmp/fixture', 'Node.js · Git']);
  setScreen(state, 'home', {
    items: [
      { id: 'start', label: 'Start an update', description: 'Choose a ZIP archive' },
      { id: 'exit', label: 'Exit' },
    ],
    status: 'Ready',
  });

  const output = renderToString(renderZipflow({ state, width: 100, height: 30 }), { width: 100, height: 30 });

  assert.match(output, new RegExp(`Zipflow ${ZIPFLOW_VERSION.replaceAll('.', '\\.')}`));
  assert.match(output, /Start an update/);
  assert.match(output, /Project detected/);
});


test('Project detected is a framed Activity block and the header does not show the theme name', () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js', 'TypeScript'], git: true };
  state.workflow = {
    archive: { mode: 'overlay' }, checks: [{ selected: true }, { selected: false }],
    policy: { label: 'Practical' }, git: { resultCommit: 'ask' }, deploy: { policy: 'disabled' },
  };
  appendMessage(state, 'Project detected', projectSummary(state.project, state.workflow), 'project');
  setScreen(state, 'home', { items: [{ id: 'exit', label: 'Exit' }], status: 'Ready' });

  const output = renderToString(renderZipflow({ state, width: 100, height: 40 }), { width: 100, height: 40 });
  assert.match(output, /┌  Project detected/);
  assert.match(output, new RegExp(`${escapeRegExp(themes.ocean.borderActive)}┌  Project detected`));
  assert.match(output, /Root:\s+\/tmp\/fixture/);
  assert.match(output, /Detected:\s+Node\.js · TypeScript/);
  assert.match(output, /Workflow: configured/);
  assert.doesNotMatch(output, /Theme:/);
});

test('Activity has an in-app selection state and Ctrl+T enables native selection elsewhere', async () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: [], git: false };
  appendMessage(state, 'Activity line', ['Selectable text']);
  setScreen(state, 'new-project', { items: [{ id: 'exit', label: 'Exit' }], status: 'Ready' });
  const controller = new ZipflowController(state);
  controller.attachRuntime({
    togglePointerOverride: () => false,
    invalidate: () => {},
  });

  assert.ok(state.activitySelection);
  await controller.handleKey({ name: 't', ctrl: true });
  assert.match(state.status, /Native text selection enabled/);

  const output = renderToString(renderZipflow({ state, width: 100, height: 30 }), { width: 100, height: 30 });
  assert.match(output, /Selectable text/);
});


test('clicking a collapsed Activity block expands it without disabling text selection', async () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: [], git: false };
  appendMessage(state, 'Long output', ['one', 'two', 'three', 'four', 'five'], 'error');
  setScreen(state, 'home', { items: [{ id: 'exit', label: 'Exit' }], status: 'Ready' });
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  const tree = renderZipflow({ state, width: 100, height: 30 });
  const region = findNode(tree, (node) => node.props?.pointerId === 'zipflow:transcript:selection');
  assert.ok(region);
  const context = { runtime: { output: { write() {} } } };
  const base = {
    button: 'left', localX: 1, localY: 0,
    preventDefault() {}, stopPropagation() {}, capturePointer() {}, releasePointerCapture() {},
  };
  region.props.onClick({ ...base, action: 'click' }, context);
  region.props.onRelease({ ...base, action: 'release' }, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.messages[0].collapsed, false);
  assert.ok(state.activitySelection);
});

test('Activity renders incremental local LLM progress and streamed text', () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], git: true };
  state.busy = true;
  state.screen = 'applying';
  state.busyLabel = 'Inspecting archive';
  state.progress = { value: 5, total: 7, detail: 'Streaming summary' };
  state.llmRuntime = {
    provider: 'lmstudio', model: 'gemma', label: 'The model is analyzing the patch',
    elapsedMs: 12_000, chunks: 8, reasoning: 'Inspecting changed files\nChecking tests', content: '',
    transport: 'LM Studio native', endpoint: '/api/v1/chat', requestModel: 'gemma-loaded', loadedModel: true,
  };

  const output = renderToString(renderZipflow({ state, width: 110, height: 32 }), { width: 110, height: 32 });

  assert.match(output, /Local LLM · lmstudio · gemma/);
  assert.match(output, /LM Studio native · POST \/api\/v1\/chat/);
  assert.match(output, /gemma-loaded · already loaded/);
  assert.match(output, /The model is analyzing the patch/);
  assert.match(output, /Checking tests/);
  const rows = output.split('\n');
  const detailRow = rows.findIndex((line) => line.includes('Streaming summary'));
  assert.ok(detailRow >= 0, output);
  assert.doesNotMatch(rows[detailRow], /%|█|▓|▒|░/u);
  const safetyRow = rows.findIndex((line) => line.includes('Zipflow is preserving the project state'));
  assert.ok(safetyRow > detailRow + 1, output);
});

test('run screens show the current five-step stage and typed Activity entries', () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], git: true };
  state.workflow = { policy: { label: 'Practical' } };
  state.run = { id: 'run-1' };
  appendMessage(state, 'Archive inspected', ['fixture.zip'], 'success');
  appendMessage(state, 'Conflict decision', ['Keep local'], 'choice');
  setScreen(state, 'plan-review', { items: [{ id: 'apply', label: 'Apply update' }], status: 'Review' });

  const output = renderToString(renderZipflow({ state, width: 100, height: 30 }), { width: 100, height: 30 });
  assert.match(output, /Stage: 2\/5 Review/);
  assert.match(output, /\[YOU \] Conflict decision/);

  const completedState = createInitialState();
  completedState.project = state.project;
  completedState.workflow = state.workflow;
  completedState.run = state.run;
  appendMessage(completedState, 'Archive inspected', ['fixture.zip'], 'success');
  setScreen(completedState, 'plan-review', { items: [{ id: 'apply', label: 'Apply update' }], status: 'Review' });
  const completedOutput = renderToString(renderZipflow({ state: completedState, width: 100, height: 30 }), { width: 100, height: 30 });
  assert.match(completedOutput, /\[DONE\] Archive inspected/);
});


test('Project detected frame uses the same visible width on every border line', () => {
  const state = createInitialState();
  appendMessage(state, 'Project detected', [
    'Root: ~/dev/zipflow',
    'Detected: Node.js',
    'Git: repository detected · Workflow: configured',
  ], 'project');
  const lines = transcriptLines(state, themes.ocean, 100).filter((line) => line.trim());
  const visible = lines.map(stripAnsi);
  assert.equal(visible[0].length, visible.at(-1).length);
  for (const line of visible.slice(1, -1)) assert.equal(line.length, visible[0].length);
  assert.ok(visible.at(-1).endsWith('┘'));
});

test('complete diff Activity lines retain added and removed line coloring', () => {
  const state = createInitialState();
  appendMessage(state, 'Run diff', [
    'diff --git a/file.js b/file.js',
    '@@ -1 +1 @@',
    '-old value',
    '+new value',
  ], 'diff');
  state.messages.at(-1).collapsed = false;
  const lines = transcriptLines(state, themes.ocean, 100);
  const removed = lines.find((line) => stripAnsi(line).includes('-old value'));
  const added = lines.find((line) => stripAnsi(line).includes('+new value'));
  assert.match(removed, /\u001b\[/);
  assert.match(added, /\u001b\[/);
  assert.notEqual(removed, added);
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
