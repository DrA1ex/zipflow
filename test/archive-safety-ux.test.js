import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { showArchiveSafetyReview } from '../src/app/run-review.js';

function controllerWithSafety(assessment = 'suspicious') {
  const state = createInitialState();
  state.workflow = { archive: { mode: 'snapshot' } };
  state.archiveInterpretation = { configuredMode: 'snapshot', mode: 'snapshot', manuallyChanged: false };
  state.archiveSafety = {
    warnings: [{
      id: 'large-deletion', severity: 'danger', title: 'Snapshot would remove a large part of the project',
      detail: '30 of 50 managed paths would be removed (60%).',
    }],
    llm: {
      mode: 'patch', assessment, confidence: 'high', reasons: ['Project configuration is unexpectedly removed.'],
    },
    acknowledged: false,
  };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  return { state, controller };
}

test('archive safety review explains deterministic and advisory warnings before application', () => {
  const { state, controller } = controllerWithSafety();
  showArchiveSafetyReview(controller);

  assert.equal(state.screen, 'archive-safety');
  assert.deepEqual(state.menuItems.map((item) => item.id), [
    'safety-review-plan', 'recheck-as-overlay', 'safety-continue', 'safety-retry',
  ]);
  assert.match(state.panelIntro.join('\n'), /Snapshot would remove a large part/);
  assert.match(state.panelIntro.join('\n'), /LLM · suspicious · high confidence/);
  assert.match(state.panelIntro.join('\n'), /advisory/);
});

test('different-project LLM verdict makes cancellation the primary action and hides archive-mode reinterpretation', () => {
  const { state, controller } = controllerWithSafety('unsuitable');
  state.archiveSafety.llm = {
    mode: 'structure', assessment: 'unsuitable', confidence: 'high',
    projectRelation: 'different-project', archiveShape: 'unknown', recommendation: 'cancel-update',
    reasons: ['The archive contains markers from another application.'],
  };
  showArchiveSafetyReview(controller);

  assert.equal(state.menuItems[0].id, 'safety-retry');
  assert.match(state.menuItems[0].label, /recommended by LLM/);
  assert.equal(state.menuItems.some((item) => item.id === 'recheck-as-overlay' || item.id === 'recheck-as-snapshot'), false);
  assert.match(state.panelIntro.join('\n'), /Project relation: different-project/);
  assert.match(state.panelIntro.join('\n'), /Recommended action: cancel-update/);
});
