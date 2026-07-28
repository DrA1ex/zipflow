import {
  createPlanDecisions,
  isPlanItemIncluded,
  resolvePlanItemDecision,
  serializePlanSelections,
  setPlanCategoryDecision,
  setPlanDecision,
} from '../plan/selection.js';

export {
  PLAN_DECISION_ARCHIVE,
  PLAN_DECISION_IDS,
  PLAN_DECISION_KEEP,
  PLAN_DECISION_UNRESOLVED,
  PLAN_DECISIONS,
  changedPlanItems,
  effectiveChangedCount,
  excludedPlanItems,
  isPlanConflict,
  keptPlanConflictItems,
  planSelectionSummary,
  selectedPlanCounts,
  selectedPlanItems,
  serializePlanSelections,
} from '../plan/selection.js';

export function initializePlanSelections(state, plan) {
  state.decisions = createPlanDecisions(plan);
  state.run.planSelections = serializePlanSelections(plan, state.decisions);
  return state.decisions;
}

export function planItemDecision(state, item) {
  return resolvePlanItemDecision(state.plan, state.decisions, item);
}

export function isPlanItemSelected(state, item) {
  return isPlanItemIncluded(state.plan, state.decisions, item);
}

export function setPlanItemDecision(state, item, decision) {
  if (!setPlanDecision(state.decisions, item, decision)) return;
  if (state.run) state.run.planSelections = serializePlanSelections(state.plan, state.decisions);
}

export function setPlanGroupDecision(state, category, decision) {
  if (!setPlanCategoryDecision(state.plan, state.decisions, category, decision)) return;
  if (state.run) state.run.planSelections = serializePlanSelections(state.plan, state.decisions);
}
