import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'terlio.js';
import { createInitialState, setScreen } from '../src/app/state.js';
import { renderZipflow } from '../src/ui/render.js';

function renderOperation(operation) {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], git: true };
  state.workflow = { policy: { label: 'Practical' } };
  state.activeOperation = operation;
  setScreen(state, 'plan-review', {
    items: [
      { id: 'apply-plan', label: 'Apply update · waiting for LLM review', disabled: true },
      { id: 'cancel-llm-review', label: operation.cancelling ? 'Cancelling LLM review…' : 'Cancel LLM review', disabled: Boolean(operation.cancelling) },
    ],
    status: 'Review update plan',
  });
  return renderToString(renderZipflow({ state, width: 100, height: 28 }), { width: 100, height: 28 });
}

test('active LLM review exposes cancellation in the global footer', () => {
  const output = renderOperation({ kind: 'llm-review', label: 'Generating local LLM review', cancelling: false });
  assert.match(output, /Esc cancel LLM/);
  assert.match(output, /Ctrl\+C cancel operation/);
  assert.match(output, /Cancel LLM review/);
});

test('LLM cancellation replaces actions with a safe stopping state', () => {
  const output = renderOperation({ kind: 'llm-review', label: 'Generating local LLM review', cancelling: true });
  assert.match(output, /Stopping safely/);
  assert.match(output, /Cancelling LLM review/);
});
