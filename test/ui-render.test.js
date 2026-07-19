import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'terlio.js';
import { createInitialState, appendMessage, setScreen } from '../src/app/state.js';
import { renderZipflow } from '../src/ui/render.js';
import { ZipflowController } from '../src/app/controller.js';

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

  assert.match(output, /Zipflow/);
  assert.match(output, /Start an update/);
  assert.match(output, /Project detected/);
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
  };

  const output = renderToString(renderZipflow({ state, width: 110, height: 32 }), { width: 110, height: 32 });

  assert.match(output, /Local LLM · lmstudio · gemma/);
  assert.match(output, /The model is analyzing the patch/);
  assert.match(output, /Checking tests/);
  assert.match(output, /8 chunks/);
});
