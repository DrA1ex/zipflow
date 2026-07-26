import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'terlio.js';
import { createInitialState } from '../src/app/state.js';
import { renderZipflow } from '../src/ui/render.js';
import { llmActivityLines } from '../src/app/llm-progress.js';

function runtimeState(screen) {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], git: true };
  state.workflow = { policy: { label: 'Practical' } };
  state.screen = screen;
  state.status = 'Working';
  state.settings.checkOutput = 'last-line';
  state.activeOperation = {
    id: 1, kind: screen.includes('deploy') ? 'deployment' : 'checks', label: 'Working', cancellable: true,
  };
  return state;
}

test('running checks retain live output and historical progress while the operation is busy', () => {
  const state = runtimeState('checks-running');
  state.checkRuntime = {
    checks: [{ id: 'tests', name: 'npm run test', cwd: '.' }],
    activeIndex: 0,
    results: [],
    lastLine: 'test 42 passed',
    estimates: { 'npm run test': 12_000 },
    expectedMs: 12_000,
    elapsedMs: 3_000,
  };

  const output = stripAnsi(renderToString(renderZipflow({ state, width: 100, height: 28 }), { width: 100, height: 28 }));
  assert.match(output, /RUN\s+Root · npm run test/);
  assert.match(output, /Current output: test 42 passed/);
  assert.match(output, /Elapsed 3s · expected median 12s/);
  assert.doesNotMatch(output, /100%/);
  assert.doesNotMatch(output, /preserving the project state while this step runs/i);
});

test('unknown deployment duration shows a loader and the current command output', () => {
  const state = runtimeState('deploy-running');
  state.deployRuntime = {
    commandText: 'npm run deploy', cwd: '.', lastLine: 'Uploading bundle 3/8',
    expectedMs: 0, elapsedMs: 2_000,
  };

  const output = stripAnsi(renderToString(renderZipflow({ state, width: 100, height: 28 }), { width: 100, height: 28 }));
  assert.match(output, /duration estimate unavailable/);
  assert.match(output, /Current output: Uploading bundle 3\/8/);
  assert.doesNotMatch(output, /100%/);
});

test('LLM work uses its historical median and does not jump to 100 percent', () => {
  const state = runtimeState('plan-review');
  state.activeOperation = { id: 1, kind: 'llm-review', label: 'Generating local LLM review', cancellable: true };
  state.llmRuntime = {
    provider: 'ollama', model: 'qwen', label: 'The model is analyzing the patch',
    expectedMs: 20_000, elapsedMs: 5_000, chunks: 4, presentation: 'review',
  };

  const output = stripAnsi(renderToString(renderZipflow({ state, width: 100, height: 28 }), { width: 100, height: 28 }));
  assert.match(output, /Elapsed 5s · expected median 20s/);
  assert.match(output, /The model is analyzing the patch/);
  assert.doesNotMatch(output, /100%/);
});

test('live LLM Activity labels are localized in Russian', () => {
  const state = runtimeState('plan-review');
  state.settings.interfaceLanguage = 'ru';
  state.i18n = { languageId: 'ru', available: [] };
  const lines = llmActivityLines({
    provider: 'ollama', model: 'qwen', label: 'The model is analyzing the patch',
    expectedMs: 20_000, elapsedMs: 5_000, chunks: 4, presentation: 'review',
    transport: 'SSE', endpoint: '/api/chat', loadedModel: true, requestModel: 'qwen',
    deliveryMode: 'chunked', batchIndex: 1, batchTotal: 3,
  }, 100, null, { state });
  const output = lines.join('\n');
  assert.match(output, /Локальная LLM/);
  assert.match(output, /Транспорт:/);
  assert.match(output, /Экземпляр модели:/);
  assert.match(output, /Модель анализирует патч/);
  assert.match(output, /Передача:/);
  assert.doesNotMatch(output, /already loaded|The model is analyzing|Delivery:/);
});

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}
