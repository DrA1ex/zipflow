export const PLAN_DECISION_ARCHIVE = 'archive';
export const PLAN_DECISION_KEEP = 'keep';
export const PLAN_DECISION_UNRESOLVED = null;

export const PLAN_DECISIONS = Object.freeze({
  ARCHIVE: PLAN_DECISION_ARCHIVE,
  KEEP: PLAN_DECISION_KEEP,
  UNRESOLVED: PLAN_DECISION_UNRESOLVED,
});

export const PLAN_DECISION_IDS = Object.freeze([
  PLAN_DECISION_ARCHIVE,
  PLAN_DECISION_KEEP,
]);

export function createPlanDecisions(plan) {
  const decisions = new Map(changedItems(plan, 'conflicts').map((item) => [item.path, PLAN_DECISION_UNRESOLVED]));
  for (const item of changedPlanItems(plan)) {
    if (!decisions.has(item.path)) decisions.set(item.path, PLAN_DECISION_ARCHIVE);
  }
  return decisions;
}

export function resolvePlanItemDecision(plan, decisions, item) {
  const itemPath = planItemPath(item);
  const explicit = itemPath === null ? undefined : decisions?.get(itemPath);
  if (explicit === PLAN_DECISION_ARCHIVE || explicit === PLAN_DECISION_KEEP) return explicit;
  return isPlanConflict(plan, itemPath) ? PLAN_DECISION_UNRESOLVED : PLAN_DECISION_ARCHIVE;
}

export function isPlanItemIncluded(plan, decisions, item) {
  return resolvePlanItemDecision(plan, decisions, item) === PLAN_DECISION_ARCHIVE;
}

export function setPlanDecision(decisions, item, decision) {
  const itemPath = planItemPath(item);
  if (!(decisions instanceof Map) || itemPath === null || !isPlanDecision(decision, { unresolved: true })) return false;
  decisions.set(itemPath, decision);
  return true;
}

export function setPlanCategoryDecision(plan, decisions, category, decision) {
  if (!isPlanDecision(decision, { unresolved: true })) return 0;
  let changed = 0;
  for (const item of changedItems(plan, category)) {
    if (setPlanDecision(decisions, item, decision)) changed += 1;
  }
  return changed;
}

export function selectedPlanItems(plan, decisions = new Map()) {
  const conflictPaths = new Set(changedItems(plan, 'conflicts').map((item) => item.path));
  return changedPlanItems(plan).filter((item) => {
    const decision = decisions.get(item.path);
    if (decision === PLAN_DECISION_KEEP) return false;
    if (conflictPaths.has(item.path)) return decision === PLAN_DECISION_ARCHIVE;
    return decision !== PLAN_DECISION_UNRESOLVED;
  });
}

export function selectedPlanCounts(plan, decisions = new Map()) {
  const counts = { created: 0, updated: 0, deleted: 0 };
  for (const item of selectedPlanItems(plan, decisions)) {
    if (Object.hasOwn(counts, item.kind)) counts[item.kind] += 1;
  }
  return counts;
}

export function effectiveChangedCount(plan, decisions = new Map()) {
  return selectedPlanItems(plan, decisions).length;
}

export function excludedPlanItems(plan, decisions = new Map()) {
  return changedPlanItems(plan).filter((item) => decisions.get(item.path) === PLAN_DECISION_KEEP);
}

export function keptPlanConflictItems(plan, decisions = new Map()) {
  return changedItems(plan, 'conflicts').filter((item) => decisions.get(item.path) === PLAN_DECISION_KEEP);
}

export function planSelectionSummary(plan, decisions = new Map()) {
  const total = changedPlanItems(plan).length;
  const selected = effectiveChangedCount(plan, decisions);
  return { total, selected, excluded: Math.max(0, total - selected) };
}

export function serializePlanSelections(plan, decisions = new Map()) {
  return changedPlanItems(plan).map((item) => ({
    path: item.path,
    kind: item.kind,
    decision: persistedDecision(decisions.get(item.path)),
  }));
}

export function isPlanDecision(value, { unresolved = false } = {}) {
  return PLAN_DECISION_IDS.includes(value) || (unresolved && value === PLAN_DECISION_UNRESOLVED);
}

export function isPlanConflict(plan, item) {
  const itemPath = planItemPath(item);
  return itemPath !== null && changedItems(plan, 'conflicts').some((candidate) => candidate.path === itemPath);
}

export function changedPlanItems(plan) {
  return ['created', 'updated', 'deleted'].flatMap((category) => changedItems(plan, category));
}

function changedItems(plan, category) {
  return Array.isArray(plan?.[category]) ? plan[category] : [];
}

function planItemPath(item) {
  if (typeof item === 'string' && item) return item;
  return typeof item?.path === 'string' && item.path ? item.path : null;
}

function persistedDecision(value) {
  if (value === PLAN_DECISION_KEEP) return PLAN_DECISION_KEEP;
  if (value === PLAN_DECISION_ARCHIVE) return PLAN_DECISION_ARCHIVE;
  return PLAN_DECISION_UNRESOLVED;
}
