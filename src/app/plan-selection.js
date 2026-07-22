export function initializePlanSelections(state, plan) {
  state.decisions = new Map(plan.conflicts.map((item) => [item.path, null]));
  for (const item of [...plan.created, ...plan.updated, ...plan.deleted]) {
    if (!state.decisions.has(item.path)) state.decisions.set(item.path, 'archive');
  }
  state.run.planSelections = serializePlanSelections(plan, state.decisions);
  return state.decisions;
}

export function planItemDecision(state, item) {
  const explicit = state.decisions?.get(item.path);
  if (explicit === 'archive' || explicit === 'keep') return explicit;
  return isConflict(state.plan, item.path) ? null : 'archive';
}

export function isPlanItemSelected(state, item) {
  return planItemDecision(state, item) === 'archive';
}

export function setPlanItemDecision(state, item, decision) {
  if (!item || !['archive', 'keep', null].includes(decision)) return;
  state.decisions.set(item.path, decision);
  if (state.run) state.run.planSelections = serializePlanSelections(state.plan, state.decisions);
}

export function setPlanGroupDecision(state, category, decision) {
  for (const item of state.plan?.[category] ?? []) setPlanItemDecision(state, item, decision);
}

export function selectedPlanItems(plan, decisions = new Map()) {
  const conflictPaths = new Set((plan.conflicts ?? []).map((item) => item.path));
  return [...plan.created, ...plan.updated, ...plan.deleted].filter((item) => {
    const decision = decisions.get(item.path);
    if (decision === 'keep') return false;
    if (conflictPaths.has(item.path)) return decision === 'archive';
    return decision !== null;
  });
}


export function selectedPlanCounts(plan, decisions = new Map()) {
  const counts = { created: 0, updated: 0, deleted: 0 };
  for (const item of selectedPlanItems(plan, decisions)) {
    if (Object.prototype.hasOwnProperty.call(counts, item.kind)) counts[item.kind] += 1;
  }
  return counts;
}

export function effectiveChangedCount(plan, decisions = new Map()) {
  return selectedPlanItems(plan, decisions).length;
}

export function excludedPlanItems(plan, decisions = new Map()) {
  return [...plan.created, ...plan.updated, ...plan.deleted].filter((item) => decisions.get(item.path) === 'keep');
}

export function planSelectionSummary(plan, decisions = new Map()) {
  const total = (plan.created?.length ?? 0) + (plan.updated?.length ?? 0) + (plan.deleted?.length ?? 0);
  const selected = effectiveChangedCount(plan, decisions);
  return { total, selected, excluded: Math.max(0, total - selected) };
}

export function serializePlanSelections(plan, decisions = new Map()) {
  return [...plan.created, ...plan.updated, ...plan.deleted].map((item) => ({
    path: item.path,
    kind: item.kind,
    decision: decisions.get(item.path) === 'keep' ? 'keep' : decisions.get(item.path) === 'archive' ? 'archive' : null,
  }));
}

function isConflict(plan, itemPath) {
  return Boolean(plan?.conflicts?.some((item) => item.path === itemPath));
}
