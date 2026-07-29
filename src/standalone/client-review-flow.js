import {
  activateReview,
  backReview,
  handleReviewKey,
  handlesReviewScreen,
  showArchiveSafetyReview,
  showConflictCheckpoint,
  showConflictSummary,
  showPlanCategories,
  showPlanReview,
} from '../app/run-review.js';
import { applySemanticSurface } from './surface-state.js';

const PLAN_GROUPS = Object.freeze([
  'created', 'updated', 'deleted', 'preserved', 'unchanged', 'skipped', 'conflicts',
]);

export { handlesReviewScreen };

export async function applyClientReviewSurface(controller, run, surface, report) {
  if (!reviewSurface(surface) || !surface.links?.plan) return false;
  await hydratePlan(controller);
  const { state } = controller;
  state.serverSurface = structuredClone(surface);
  state.run = {
    ...state.run,
    id: run.runId,
    status: run.status,
    llm: report?.llm ?? run.summary?.llm ?? null,
  };
  state.archiveSafety = legacyArchiveSafety(report?.archiveSafety);
  state.archiveInterpretation = interpretation(surface, state.workflow);
  state.llmReviewInput = true;
  state.llmReviewPending = surface.actions?.some(({ id }) => id === 'cancel-operation') === true;
  state.activeOperation = state.llmReviewPending
    ? { kind: 'llm-review', id: run.operationId }
    : null;

  if (surface.actions?.some(({ id }) => id === 'create-checkpoint')) {
    showConflictCheckpoint(controller);
  } else if (surface.kind === 'archive_safety') {
    showArchiveSafetyReview(controller);
  } else if (surface.kind === 'conflict_summary' || surface.kind === 'conflict_file') {
    showConflictSummary(controller);
  } else {
    showPlanReview(controller);
  }
  return true;
}

export async function showClientPlan(controller) {
  await hydratePlan(controller);
  showPlanCategories(controller);
}

export function activateClientReview(controller, itemId) {
  return activateReview(controller, itemId, reviewActions);
}

export function backClientReview(controller) {
  return backReview(controller);
}

export function handleClientReviewKey(controller, key) {
  return handleReviewKey(controller, key);
}

export async function loadClientPlanDiff(controller, item) {
  const resource = await controller.client.getDiff(controller.runId, {
    path: item.path,
    mode: controller.state.settings?.lastDiffMode ?? 'unified',
  });
  return {
    path: resource.path,
    binary: resource.binary === true,
    message: resource.message ?? '',
    rows: (resource.hunks ?? []).flatMap(({ lines = [] }) => lines.map((line) => ({
      type: line.type === 'context' ? 'same' : line.type,
      oldNo: line.oldLine,
      newNo: line.newLine,
      oldText: line.oldText ?? line.text ?? '',
      newText: line.newText ?? line.text ?? '',
    }))),
  };
}

async function hydratePlan(controller) {
  const groups = {};
  let counts = {};
  for (const group of PLAN_GROUPS) {
    const page = await allPlanItems(controller, group);
    groups[group] = page.items.map((item) => ({ ...item, kind: group }));
    if (Object.keys(page.counts).length) counts = page.counts;
  }
  const decisions = new Map();
  for (const group of ['created', 'updated', 'deleted', 'conflicts']) {
    for (const item of groups[group]) {
      if (item.decision === 'archive' || item.decision === 'keep' || item.decision === null) {
        decisions.set(item.path, item.decision);
      }
    }
  }
  controller.state.plan = {
    ...groups,
    counts: {
      created: groups.created.length,
      updated: groups.updated.length,
      deleted: groups.deleted.length,
      preserved: groups.preserved.length,
      unchanged: groups.unchanged.length,
      skipped: groups.skipped.length,
      conflicts: groups.conflicts.length,
      ...counts,
    },
    ignoredIncoming: groups.skipped,
  };
  controller.state.decisions = decisions;
  controller.serverPlanDecisions = new Map(decisions);
}

async function allPlanItems(controller, group) {
  const items = [];
  let cursor = null;
  let counts = {};
  do {
    const page = await controller.client.getPlan(controller.runId, {
      group,
      cursor: cursor ?? undefined,
      limit: 100,
    });
    items.push(...(page.items ?? []));
    counts = page.counts ?? counts;
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return { items, counts };
}

const reviewActions = Object.freeze({
  skipPendingLlmReview: (controller) => dispatchById(controller, 'cancel-operation', {}),
  restartLlmReview: (controller) => dispatchById(controller, 'restart-llm-review', {}),
  reinterpretArchive: (controller, mode) => dispatchById(
    controller,
    mode === 'snapshot' ? 'reinterpret-as-snapshot' : 'reinterpret-as-overlay',
    {},
  ),
  startDeletionIntentReview: (controller) => dispatchById(
    controller,
    'review-deletion-intent',
    {},
  ),
  continueAfterSafety: (controller) => dispatchById(
    controller,
    'acknowledge-archive-safety',
    {},
  ),
  startApply: async (controller) => {
    await syncPlanDecisions(controller);
    return dispatchById(controller, 'approve-plan', {});
  },
  retryArchive: cancelAndChooseArchive,
  cancelRun: cancelAndChooseArchive,
  createCheckpointAndApply: (controller) => dispatchById(controller, 'create-checkpoint', {}),
  continueWithoutCheckpoint: (controller) => dispatchById(
    controller,
    'continue-without-checkpoint',
    {},
  ),
});

async function syncPlanDecisions(controller) {
  const current = controller.serverPlanDecisions ?? new Map();
  const local = controller.state.decisions ?? new Map();
  const conflictPaths = new Set(controller.state.plan?.conflicts?.map(({ path }) => path) ?? []);
  const changes = [...local.entries()]
    .filter(([path, decision]) => (
      ['archive', 'keep'].includes(decision) && current.get(path) !== decision
    ))
    .sort(([left], [right]) => (
      Number(conflictPaths.has(right)) - Number(conflictPaths.has(left))
    ));
  for (const [path, decision] of changes) {
    const actionId = conflictPaths.has(path) ? 'resolve-conflict' : decision === 'archive'
      ? 'use-archive'
      : 'keep-local';
    const input = actionId === 'resolve-conflict' ? { path, decision } : { path };
    await dispatchById(controller, actionId, input, { refresh: false });
    current.set(path, decision);
  }
  controller.serverPlanDecisions = current;
}

async function dispatchById(controller, actionId, input, { refresh = true } = {}) {
  const action = controller.state.serverSurface?.actions?.find(({ id }) => id === actionId);
  if (!action || action.enabled === false) {
    throw Object.assign(new Error(
      action?.disabledReason ?? `The server did not advertise ${actionId}.`,
    ), { code: 'ACTION_NOT_AVAILABLE' });
  }
  const result = await controller.client.performAction(
    controller.runId,
    actionId,
    input,
    {
      ifMatch: controller.state.serverSurface.revision,
      idempotencyKey: `zipflow:tui:review:${controller.runId}:${actionId}:${controller.createId()}`,
    },
  );
  const body = result.body ?? result;
  if (body.surface) {
    controller.state.serverSurface = structuredClone(body.surface);
    applySemanticSurface(controller.state, body.surface);
  }
  if (refresh) await controller.refreshRun();
  return body;
}

async function cancelAndChooseArchive(controller) {
  await dispatchById(controller, 'cancel-run', {}, { refresh: false });
  controller.runId = '';
  controller.operationId = '';
  return controller.promptArchive();
}

function reviewSurface(surface) {
  return [
    'archive_safety', 'plan_review', 'plan_files', 'conflict_summary', 'conflict_file',
  ].includes(surface?.kind);
}

function interpretation(surface, workflow) {
  if (surface.actions?.some(({ id }) => id === 'reinterpret-as-overlay')) {
    return { mode: 'snapshot', source: 'manual' };
  }
  if (surface.actions?.some(({ id }) => id === 'reinterpret-as-snapshot')) {
    return { mode: 'overlay', source: 'manual' };
  }
  return { mode: workflow?.archive?.mode ?? 'overlay', source: 'workflow' };
}

function legacyArchiveSafety(value) {
  const safety = value ?? {};
  return {
    acknowledged: safety.acknowledged === true,
    warnings: (safety.warnings ?? []).map((warning) => {
      const [title, ...detail] = String(warning.message ?? '').split(': ');
      return {
        id: warning.code,
        title: title || warning.code || 'Archive warning',
        detail: detail.join(': '),
        severity: warning.severity ?? 'warning',
      };
    }),
    llm: safety.llm ?? null,
    deletionIntent: safety.deletionIntent ?? null,
  };
}
