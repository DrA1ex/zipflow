import test from 'node:test';
import assert from 'node:assert/strict';
import { showPlanReview } from '../src/app/run-review.js';

function planFixture() {
  return {
    created: [], updated: [{ path: 'src/app.js' }], deleted: [], preserved: [], skipped: [], conflicts: [], ignoredIncoming: [],
    counts: { created: 0, updated: 1, deleted: 0, preserved: 0, skipped: 0, conflicts: 0 },
  };
}

function controllerFixture(overrides = {}) {
  const state = {
    plan: planFixture(),
    decisions: new Map(),
    archiveSafety: { warnings: [] },
    llmReviewPending: true,
    llmReviewCancelling: false,
    llmReviewInput: { plan: planFixture() },
    activeOperation: { kind: 'llm-review', label: 'Generating local LLM review' },
    workflow: { autonomy: { mode: 'manual' } },
    run: { id: 'run-1' },
    ...overrides,
  };
  return {
    state,
    showMenu(screen, items, status, selectedIndex, intro) {
      Object.assign(this.lastMenu = {}, { screen, items, status, selectedIndex, intro });
    },
  };
}

test('plan review blocks Apply for every active LLM task and exposes cancellation', () => {
  const controller = controllerFixture();
  showPlanReview(controller);
  const apply = controller.lastMenu.items.find((item) => item.id === 'apply-plan');
  const cancelLlm = controller.lastMenu.items.find((item) => item.id === 'cancel-llm-review');
  const cancelRun = controller.lastMenu.items.find((item) => item.id === 'cancel-run');
  assert.equal(apply.disabled, true);
  assert.ok(cancelLlm);
  assert.equal(cancelLlm.disabled, false);
  assert.equal(cancelRun.disabled, true);
  assert.match(controller.lastMenu.intro.join('\n'), /Apply waits until the review finishes or is cancelled/);
});

test('cancelling LLM review disables repeated cancellation until the request closes', () => {
  const controller = controllerFixture({ llmReviewCancelling: true });
  showPlanReview(controller);
  const cancelLlm = controller.lastMenu.items.find((item) => item.id === 'cancel-llm-review');
  assert.equal(cancelLlm.disabled, true);
  assert.match(cancelLlm.label, /Cancelling/);
  assert.match(controller.lastMenu.intro.join('\n'), /Stopping the LLM review safely/);
});

test('cancelled LLM review offers restart and re-enables Apply', () => {
  const controller = controllerFixture({
    llmReviewPending: false,
    activeOperation: null,
    run: { id: 'run-1', llm: { cancelled: true } },
  });
  showPlanReview(controller);
  const apply = controller.lastMenu.items.find((item) => item.id === 'apply-plan');
  const restart = controller.lastMenu.items.find((item) => item.id === 'restart-llm-review');
  assert.equal(apply.disabled, false);
  assert.ok(restart);
  assert.match(controller.lastMenu.intro.join('\n'), /LLM review was cancelled/);
});
