import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as legacySelection from '../src/app/plan-selection.js';
import {
  PLAN_DECISION_ARCHIVE,
  PLAN_DECISION_IDS,
  PLAN_DECISION_KEEP,
  PLAN_DECISION_UNRESOLVED,
  PLAN_DECISIONS,
  createPlanDecisions,
  effectiveChangedCount,
  excludedPlanItems,
  isPlanItemIncluded,
  keptPlanConflictItems,
  planSelectionSummary,
  resolvePlanItemDecision,
  selectedPlanCounts,
  selectedPlanItems,
  serializePlanSelections,
  setPlanCategoryDecision,
  setPlanDecision,
} from '../src/plan/selection.js';

function planFixture() {
  const updated = {
    kind: 'updated', path: 'src/conflict.js', sourcePath: '/archive/src/conflict.js',
    beforeHash: 'before', afterHash: 'after',
  };
  return {
    created: [{ kind: 'created', path: 'src/new.js', sourcePath: '/archive/src/new.js', afterHash: 'new' }],
    updated: [updated, { kind: 'updated', path: 'README.md', sourcePath: '/archive/README.md', beforeHash: 'old', afterHash: 'new' }],
    deleted: [{ kind: 'deleted', path: 'legacy.txt', beforeHash: 'legacy' }],
    conflicts: [{ ...updated, reason: 'local work' }],
  };
}

test('plan decisions expose stable path-keyed semantic IDs', () => {
  assert.equal(PLAN_DECISION_ARCHIVE, 'archive');
  assert.equal(PLAN_DECISION_KEEP, 'keep');
  assert.equal(PLAN_DECISION_UNRESOLVED, null);
  assert.deepEqual(PLAN_DECISION_IDS, ['archive', 'keep']);
  assert.deepEqual(PLAN_DECISIONS, { ARCHIVE: 'archive', KEEP: 'keep', UNRESOLVED: null });

  const plan = planFixture();
  const decisions = createPlanDecisions(plan);
  assert.deepEqual([...decisions], [
    ['src/conflict.js', null],
    ['src/new.js', 'archive'],
    ['README.md', 'archive'],
    ['legacy.txt', 'archive'],
  ]);
  assert.equal(resolvePlanItemDecision(plan, decisions, plan.updated[0]), null);
  assert.equal(resolvePlanItemDecision(plan, decisions, plan.created[0]), 'archive');
});

test('domain selection preserves archive, keep-local, and unresolved conflict behavior', () => {
  const plan = planFixture();
  const decisions = createPlanDecisions(plan);
  assert.deepEqual(selectedPlanItems(plan, decisions).map((item) => item.path), [
    'src/new.js', 'README.md', 'legacy.txt',
  ]);
  assert.equal(isPlanItemIncluded(plan, decisions, plan.updated[0]), false);

  assert.equal(setPlanDecision(decisions, 'src/conflict.js', PLAN_DECISIONS.ARCHIVE), true);
  assert.equal(setPlanDecision(decisions, plan.updated[1], PLAN_DECISIONS.KEEP), true);
  assert.equal(setPlanDecision(decisions, null, PLAN_DECISIONS.KEEP), false);
  assert.deepEqual(selectedPlanItems(plan, decisions).map((item) => item.path), [
    'src/new.js', 'src/conflict.js', 'legacy.txt',
  ]);
  assert.deepEqual(selectedPlanCounts(plan, decisions), { created: 1, updated: 1, deleted: 1 });
  assert.equal(effectiveChangedCount(plan, decisions), 3);
  assert.deepEqual(excludedPlanItems(plan, decisions).map((item) => item.path), ['README.md']);
  assert.deepEqual(keptPlanConflictItems(plan, decisions), []);
  assert.deepEqual(planSelectionSummary(plan, decisions), { total: 4, selected: 3, excluded: 1 });

  setPlanDecision(decisions, 'src/conflict.js', PLAN_DECISIONS.KEEP);
  assert.deepEqual(keptPlanConflictItems(plan, decisions).map((item) => item.path), ['src/conflict.js']);
});

test('category decisions and serialized receipts remain independent of menu indexes', () => {
  const plan = planFixture();
  const decisions = createPlanDecisions(plan);
  assert.equal(setPlanCategoryDecision(plan, decisions, 'updated', PLAN_DECISION_KEEP), 2);
  assert.equal(setPlanCategoryDecision(plan, decisions, 'missing', PLAN_DECISION_ARCHIVE), 0);
  assert.deepEqual(serializePlanSelections(plan, decisions), [
    { path: 'src/new.js', kind: 'created', decision: 'archive' },
    { path: 'src/conflict.js', kind: 'updated', decision: 'keep' },
    { path: 'README.md', kind: 'updated', decision: 'keep' },
    { path: 'legacy.txt', kind: 'deleted', decision: 'archive' },
  ]);

  plan.updated.reverse();
  assert.equal(decisions.get('src/conflict.js'), 'keep');
  assert.equal(decisions.get('README.md'), 'keep');
});

test('legacy TUI adapter preserves signatures and persisted run selections', () => {
  const plan = planFixture();
  const state = { plan, run: { id: 'run-selection' }, decisions: null };
  legacySelection.initializePlanSelections(state, plan);
  assert.equal(legacySelection.planItemDecision(state, plan.updated[0]), null);
  legacySelection.setPlanItemDecision(state, plan.updated[0], 'archive');
  legacySelection.setPlanGroupDecision(state, 'deleted', 'keep');
  assert.equal(legacySelection.isPlanItemSelected(state, plan.updated[0]), true);
  assert.deepEqual(state.run.planSelections, [
    { path: 'src/new.js', kind: 'created', decision: 'archive' },
    { path: 'src/conflict.js', kind: 'updated', decision: 'archive' },
    { path: 'README.md', kind: 'updated', decision: 'archive' },
    { path: 'legacy.txt', kind: 'deleted', decision: 'keep' },
  ]);
  assert.equal(legacySelection.selectedPlanItems, selectedPlanItems);
});

test('apply depends on the terminal-neutral plan boundary, never src/app', async () => {
  const source = await readFile(new URL('../src/apply/apply.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\.\/plan\/selection\.js'/);
  assert.doesNotMatch(source, /app\/plan-selection/);
});
