import { loadPlanItemDiff } from '../diff/file.js';
import { loadStoredFileDiff } from '../diff/stored-patch.js';
import { rememberDiffMode } from '../settings/recent.js';
import { compactPlanLine, compactPlanMeta } from '../ui/format.js';
import { setScreen } from './state.js';
import { autopilotPaused, resumeAutopilot } from './autonomy-flow.js';

const PLAN_GROUPS = [
  ['created', 'Added', 'Files that do not exist locally and will be created'],
  ['updated', 'Changed', 'Files whose archive content differs from the local version'],
  ['deleted', 'Removed', 'Local files absent from the selected snapshot scope'],
  ['preserved', 'Preserved', 'Local files intentionally kept by the deletion or ignore policy'],
  ['skipped', 'Ignored', 'Incoming paths excluded by workflow, protection, or .gitignore'],
  ['conflicts', 'Conflicts', 'Files with local Git changes that require a decision'],
];

export function handlesReviewScreen(screen) {
  return [
    'archive-safety', 'plan-review', 'plan-details', 'plan-files', 'conflict-summary', 'conflict-file',
    'conflict-checkpoint', 'diff-view',
  ].includes(screen);
}

export async function activateReview(controller, itemId, actions) {
  const { state } = controller;
  if (state.screen === 'archive-safety') {
    if (itemId === 'safety-review-plan') {
      state.archiveSafety.acknowledged = true;
      return showPlanCategories(controller);
    }
    if (itemId === 'safety-continue') {
      state.archiveSafety.acknowledged = true;
      return actions.continueAfterSafety(controller);
    }
    if (itemId === 'safety-retry') return actions.retryArchive(controller);
  }
  if (state.screen === 'plan-review') {
    if (itemId === 'view-plan') return showPlanCategories(controller);
    if (itemId === 'skip-llm-review') {
      await actions.skipPendingLlmReview(controller);
      return showPlanReview(controller);
    }
    if (itemId === 'resume-autopilot') {
      await resumeAutopilot(controller);
      return actions.continueAfterSafety(controller);
    }
    if (itemId === 'apply-plan') return actions.startApply(controller);
    if (itemId === 'cancel-run') return actions.cancelRun(controller);
  }
  if (state.screen === 'plan-details') {
    if (itemId.startsWith('plan-category:')) return showPlanFiles(controller, itemId.slice(14));
    if (itemId === 'apply-plan') return actions.startApply(controller);
    if (itemId === 'back-to-plan') return showPlanReview(controller);
  }
  if (state.screen === 'plan-files') {
    if (itemId.startsWith('plan-file:')) return activatePlanFile(controller, itemId);
    if (itemId === 'back-plan-categories') return showPlanCategories(controller);
    if (itemId === 'apply-plan') return actions.startApply(controller);
  }
  if (state.screen === 'conflict-summary') return activateConflictSummary(controller, itemId, actions);
  if (state.screen === 'conflict-file') return activateConflictFile(controller, itemId, actions);
  if (state.screen === 'conflict-checkpoint') return activateCheckpoint(controller, itemId, actions);
  return false;
}

export function backReview(controller) {
  const { state } = controller;
  if (state.screen === 'archive-safety') return false;
  if (state.screen === 'plan-details') return showPlanReview(controller);
  if (state.screen === 'plan-files') return showPlanCategories(controller);
  if (state.screen === 'conflict-file') return showConflictSummary(controller);
  if (state.screen === 'conflict-checkpoint') return showPlanReview(controller);
  if (state.screen === 'diff-view') return closeDiff(controller);
  return false;
}

export function handleReviewKey(controller, key) {
  const { state } = controller;
  if (state.screen === 'diff-view') {
    if (key.name === 'escape') return closeDiff(controller), true;
    if (key.name === 'm' || key.name === 'tab' || key.name === 'left' || key.name === 'right') {
      state.diffView.mode = state.diffView.mode === 'unified' ? 'side-by-side' : 'unified';
      state.diffView.pendingHunkJump = true;
      void rememberDiffMode(state, state.diffView.mode).catch(() => {});
      controller.setStatus(`Diff mode: ${state.diffView.mode}`);
      return true;
    }
    const printableName = String(key.text ?? key.name ?? '').toLowerCase();
    if (['j', 'k', '{', '}'].includes(printableName) && state.diffView.files?.length > 1) {
      const delta = printableName === 'j' || printableName === '}' ? 1 : -1;
      void moveDiffFile(controller, delta).catch((error) => controller.handleUnexpected(error));
      return true;
    }
    if (['n', 'p', ']', '['].includes(printableName)) {
      const delta = printableName === 'n' || printableName === ']' ? 1 : -1;
      const count = Math.max(1, state.diffView.hunkCount ?? 1);
      const next = ((state.diffView.hunkIndex ?? 0) + delta + count) % count;
      jumpToHunk(state.diffView, next);
      controller.setStatus(`Diff hunk ${next + 1} of ${count}`);
      return true;
    }
    if (['up', 'down', 'page-up', 'page-down', 'home', 'end'].includes(key.name)) {
      const step = key.name === 'up' ? -1 : key.name === 'down' ? 1 : key.name === 'page-up' ? -12 : key.name === 'page-down' ? 12 : 0;
      if (key.name === 'home') state.diffView.scroll = 0;
      else if (key.name === 'end') state.diffView.scroll = Number.MAX_SAFE_INTEGER;
      else state.diffView.scroll = Math.max(0, state.diffView.scroll + step);
      controller.invalidate();
      return true;
    }
  }
  if (state.screen === 'conflict-file' && key.printable) {
    const name = String(key.text ?? key.name ?? '').toLowerCase();
    if (name === 'a') return runShortcut(controller, 'conflict-use-archive'), true;
    if (name === 'l') return runShortcut(controller, 'conflict-keep-local'), true;
    if (name === 'd') return runShortcut(controller, 'conflict-view-diff'), true;
  }
  return false;
}

export function showArchiveSafetyReview(controller) {
  const safety = controller.state.archiveSafety ?? { warnings: [] };
  const dangerous = safety.warnings.some((item) => item.severity === 'danger')
    || safety.llm?.assessment === 'unsuitable';
  const lines = safetyLines(safety);
  controller.showMenu('archive-safety', [
    { id: 'safety-review-plan', label: 'Review changed files', description: 'Inspect groups and diffs before deciding whether to apply' },
    { id: 'safety-continue', label: 'Continue despite warnings', description: dangerous ? 'The archive remains subject to backup, conflict handling, and checks' : 'Acknowledge the advisory warnings and continue normally' },
    { id: 'safety-retry', label: 'Choose another archive', description: 'Cancel this run without changing the project' },
  ], dangerous ? 'Archive needs careful review' : 'Archive safety warning', dangerous ? 0 : 0, lines);
}

export function showPlanReview(controller) {
  const { plan, llmReviewPending } = controller.state;
  const gated = llmReviewPending && controller.state.runSettings?.llmArchiveReview !== 'disabled';
  const items = [
    { id: 'apply-plan', label: gated ? 'Apply update · waiting for LLM review' : 'Apply update', description: plan.conflicts.length ? 'Uses the conflict decisions shown above' : 'Backup is created before any local file changes', disabled: gated },
    { id: 'view-plan', label: 'Review changes', description: 'Open file groups and inspect unified or side-by-side diffs' },
  ];
  if (gated) items.push({ id: 'skip-llm-review', label: 'Continue without LLM verdict', description: 'Cancel the advisory LLM step; deterministic protections remain active' });
  if (autopilotPaused(controller.state)) items.push({ id: 'resume-autopilot', label: 'Resume autopilot', description: 'Ask the local model to decide this plan checkpoint again.' });
  items.push({ id: 'cancel-run', label: 'Cancel update', description: 'Return without changing the project' });
  const intro = [compactPlanLine(plan), compactPlanMeta(plan), ...planWarnings(plan, controller.state.archiveSafety)];
  if (llmReviewPending) intro.push(gated ? 'LLM review is running. Files and diffs remain available while Apply waits for the verdict.' : 'LLM summary is running in the background and does not block Apply.');
  controller.showMenu('plan-review', items, 'Review update plan', 0, intro);
}

export function showConflictSummary(controller) {
  const { plan } = controller.state;
  controller.showMenu('conflict-summary', [
    { id: 'replace-all-conflicts', label: 'Use archive for every conflict', description: 'Every affected local file is backed up before replacement' },
    { id: 'keep-all-conflicts', label: 'Keep every local conflict', description: 'Safe files still apply; conflicting local files remain unchanged' },
    { id: 'choose-conflicts', label: 'Review conflicts one by one', description: 'See the reason, inspect a diff, and choose the winning version' },
    { id: 'retry-archive', label: 'Cancel and choose another archive', description: 'Discard this plan and return to ZIP selection' },
  ], `${plan.conflicts.length} conflicts need a decision`, 0, [compactPlanLine(plan), compactPlanMeta(plan)]);
}

export function showConflictCheckpoint(controller) {
  const count = archiveConflictPaths(controller.state).length;
  controller.showMenu('conflict-checkpoint', [
    { id: 'checkpoint-replace', label: 'Create checkpoint commit, then apply', description: `Commit ${count} affected local paths before archive versions replace them` },
    { id: 'replace-without-checkpoint', label: 'Apply without checkpoint commit', description: 'The normal Zipflow backup is still created and supports rollback' },
    { id: 'back-to-plan', label: 'Back to update plan' },
  ], 'Protect affected local changes with Git', 0, [`Archive versions selected for ${count} conflicting paths.`]);
}

export function archiveConflictPaths(state) {
  return state.plan.conflicts.filter((item) => state.decisions.get(item.path) === 'archive').map((item) => item.path);
}

function showPlanCategories(controller) {
  const { plan } = controller.state;
  const items = PLAN_GROUPS.flatMap(([id, label, description]) => {
    const count = plan[id]?.length ?? 0;
    return count ? [{ id: `plan-category:${id}`, label: `${label} · ${count}`, description }] : [];
  });
  items.push(
    { id: 'apply-plan', label: controller.state.llmReviewPending && controller.state.runSettings?.llmArchiveReview !== 'disabled' ? 'Apply update · waiting for LLM review' : 'Apply update', disabled: controller.state.llmReviewPending && controller.state.runSettings?.llmArchiveReview !== 'disabled' },
    { id: 'back-to-plan', label: 'Back to summary' },
  );
  controller.showMenu('plan-details', items, 'Review changed files', null, [compactPlanLine(plan), 'Choose a group. Enter on a changed file opens its diff.']);
}

function showPlanFiles(controller, category, selectedIndex = null) {
  const { plan } = controller.state;
  const group = PLAN_GROUPS.find(([id]) => id === category);
  if (!group) return showPlanCategories(controller);
  controller.state.planReview = { category };
  const items = (plan[category] ?? []).map((item, index) => ({
    id: `plan-file:${category}:${index}`,
    label: item.path,
    description: item.reason ?? (isDiffable(category) ? 'Enter to view diff' : group[2]),
  }));
  items.push(
    { id: 'back-plan-categories', label: 'Back to groups' },
    { id: 'apply-plan', label: controller.state.llmReviewPending && controller.state.runSettings?.llmArchiveReview !== 'disabled' ? 'Apply update · waiting for LLM review' : 'Apply update', disabled: controller.state.llmReviewPending && controller.state.runSettings?.llmArchiveReview !== 'disabled' },
  );
  controller.showMenu('plan-files', items, `${group[1]} files`, selectedIndex, [`${group[1]} · ${plan[category].length}`, group[2]]);
}

async function activatePlanFile(controller, itemId) {
  const [, category, rawIndex] = itemId.split(':');
  const item = controller.state.plan[category]?.[Number(rawIndex)];
  if (!item) return;
  if (isDiffable(category)) return openDiff(controller, item);
  controller.message('File detail', [item.path, item.reason ?? 'No additional detail']);
  return showPlanFiles(controller, category, controller.state.selectedIndex);
}

function activateConflictSummary(controller, itemId, actions) {
  const { state } = controller;
  if (itemId === 'replace-all-conflicts' || itemId === 'keep-all-conflicts') {
    const decision = itemId === 'replace-all-conflicts' ? 'archive' : 'keep';
    for (const conflict of state.plan.conflicts) state.decisions.set(conflict.path, decision);
    controller.message('Conflict decision', [`${decision === 'archive' ? 'Archive' : 'Local'} version selected for all ${state.plan.conflicts.length} conflicts.`], 'choice');
    return showPlanReview(controller);
  }
  if (itemId === 'choose-conflicts') {
    state.conflictReview = { index: 0, resolved: new Set() };
    state.reviewActions = actions;
    return showConflictFile(controller);
  }
  if (itemId === 'retry-archive') return actions.retryArchive(controller);
}

async function activateConflictFile(controller, itemId, actions) {
  const { state } = controller;
  const review = state.conflictReview;
  const conflict = state.plan.conflicts[review?.index ?? 0];
  if (!conflict) return finishConflictReview(controller);
  if (itemId === 'conflict-view-diff') return openDiff(controller, conflict);
  if (itemId === 'back-conflict-summary') return showConflictSummary(controller);
  if (itemId === 'conflict-use-archive-all' || itemId === 'conflict-keep-local-all') {
    const decision = itemId === 'conflict-use-archive-all' ? 'archive' : 'keep';
    for (let index = review.index; index < state.plan.conflicts.length; index += 1) {
      const item = state.plan.conflicts[index];
      state.decisions.set(item.path, decision);
      review.resolved.add(item.path);
    }
    return finishConflictReview(controller);
  }
  if (itemId === 'conflict-use-archive' || itemId === 'conflict-keep-local') {
    const decision = itemId === 'conflict-use-archive' ? 'archive' : 'keep';
    state.decisions.set(conflict.path, decision);
    review.resolved.add(conflict.path);
    controller.message('Conflict resolved', [`${conflict.path} · ${decision === 'archive' ? 'use archive' : 'keep local'}`], 'choice');
    review.index += 1;
    return review.index >= state.plan.conflicts.length ? finishConflictReview(controller) : showConflictFile(controller);
  }
  return actions ? false : undefined;
}

function showConflictFile(controller) {
  const { state } = controller;
  const review = state.conflictReview;
  const conflict = state.plan.conflicts[review.index];
  if (!conflict) return finishConflictReview(controller);
  const current = state.decisions.get(conflict.path);
  controller.showMenu('conflict-file', [
    { id: 'conflict-use-archive', label: 'Use archive version', description: conflict.kind === 'deleted' ? 'Delete the local file after backup' : 'Replace the local file after backup' },
    { id: 'conflict-keep-local', label: 'Keep local version', description: 'Skip this conflicting archive change' },
    { id: 'conflict-view-diff', label: 'View diff', description: 'Switch between unified and side-by-side views with M' },
    { id: 'conflict-use-archive-all', label: 'Use archive for all remaining conflicts' },
    { id: 'conflict-keep-local-all', label: 'Keep local for all remaining conflicts' },
    { id: 'back-conflict-summary', label: 'Back to bulk choices' },
  ], `Conflict ${review.index + 1} of ${state.plan.conflicts.length}`, 0, [
    `${conflict.kind.toUpperCase()} · ${conflict.path}`,
    conflict.reason,
    current ? `Current decision: ${current === 'archive' ? 'use archive' : 'keep local'}` : 'No decision yet',
  ]);
}

function finishConflictReview(controller) {
  const { state } = controller;
  const archiveCount = archiveConflictPaths(state).length;
  const localCount = state.plan.conflicts.length - archiveCount;
  controller.message('Conflict review completed', [`${archiveCount} use archive · ${localCount} keep local`], 'success');
  return showPlanReview(controller);
}

async function activateCheckpoint(controller, itemId, actions) {
  if (itemId === 'checkpoint-replace') {
    await actions.createCheckpoint(controller);
    return actions.startApply(controller, { checkpointCreated: true });
  }
  if (itemId === 'replace-without-checkpoint') return actions.startApply(controller, { checkpointCreated: true });
  if (itemId === 'back-to-plan') return showPlanReview(controller);
}

async function openDiff(controller, item) {
  const files = diffFilesForCurrentScreen(controller.state, item);
  const fileIndex = Math.max(0, files.findIndex((candidate) => candidate.path === item.path));
  const diff = await loadPlanItemDiff(files[fileIndex] ?? item);
  controller.state.diffView = {
    diff,
    source: 'plan',
    files,
    fileIndex,
    mode: controller.state.settings?.lastDiffMode ?? 'unified',
    scroll: 0,
    hunkIndex: 0,
    hunkCount: 1,
    hunkOffsets: [0],
    returnScreen: controller.state.screen,
    returnItems: controller.state.menuItems,
    returnSourceItems: controller.state.menuSourceItems,
    returnIndex: controller.state.selectedIndex,
    returnStatus: controller.state.status,
    returnIntro: controller.state.panelIntro,
  };
  setScreen(controller.state, 'diff-view', { status: `Diff · ${item.path}`, intro: [] });
  controller.invalidate();
}

function closeDiff(controller) {
  const view = controller.state.diffView;
  if (!view) return showPlanReview(controller);
  setScreen(controller.state, view.returnScreen, {
    items: view.returnSourceItems ?? view.returnItems,
    selectedIndex: view.returnIndex,
    status: view.returnStatus,
    intro: view.returnIntro,
  });
  controller.state.diffView = null;
  controller.invalidate();
}


async function moveDiffFile(controller, delta) {
  const view = controller.state.diffView;
  if (!view?.files?.length) return;
  view.fileIndex = (view.fileIndex + delta + view.files.length) % view.files.length;
  const file = view.files[view.fileIndex];
  view.diff = view.source === 'stored'
    ? await loadStoredFileDiff(view.run, file.path ?? file)
    : await loadPlanItemDiff(file);
  view.scroll = 0;
  view.hunkIndex = 0;
  view.hunkCount = 1;
  view.hunkOffsets = [0];
  view.pendingHunkJump = true;
  controller.setStatus(`Diff file ${view.fileIndex + 1} of ${view.files.length} · ${view.diff.path}`);
}

function diffFilesForCurrentScreen(state, item) {
  if (state.screen === 'plan-files') {
    return (state.plan[state.planReview?.category] ?? []).filter((candidate) => candidate.kind !== 'preserved' && candidate.kind !== 'skipped');
  }
  if (state.screen === 'conflict-file') return state.plan.conflicts ?? [item];
  return [item];
}

function jumpToHunk(view, index) {
  view.hunkIndex = Math.max(0, index);
  view.scroll = view.hunkOffsets?.[view.hunkIndex] ?? 0;
  view.pendingHunkJump = false;
}

function runShortcut(controller, itemId) {
  void activateConflictFile(controller, itemId, controller.state.reviewActions)
    .catch((error) => controller.handleUnexpected(error));
}

function planWarnings(plan, safety = null) {
  const lines = [];
  for (const warning of safety?.warnings ?? []) lines.push(`${warning.title}: ${warning.detail}`);
  if (safety?.llm && safety.llm.assessment !== 'suitable') {
    lines.push(`LLM archive assessment: ${safety.llm.assessment} · ${safety.llm.confidence} confidence`);
  }
  if (plan.ignoredIncoming.length) lines.push(`${plan.ignoredIncoming.length} incoming paths are ignored by .gitignore`);
  if (plan.preserved.length) lines.push(`${plan.preserved.length} local paths will be preserved`);
  if (!lines.length) lines.push('No ignored or preserved paths require attention.');
  return lines;
}

function safetyLines(safety) {
  const lines = [];
  for (const warning of safety.warnings ?? []) lines.push(`${warning.severity === 'danger' ? 'HIGH' : 'WARN'} · ${warning.title}`, `  ${warning.detail}`);
  if (safety.llm) {
    lines.push(`LLM · ${safety.llm.assessment} · ${safety.llm.confidence} confidence`);
    for (const reason of safety.llm.reasons ?? []) lines.push(`  ${reason}`);
  }
  lines.push('', 'The LLM verdict is advisory. Zipflow still applies deterministic path, Git, backup, and test protections.');
  return lines;
}

function isDiffable(category) {
  return ['created', 'updated', 'deleted', 'conflicts'].includes(category);
}
