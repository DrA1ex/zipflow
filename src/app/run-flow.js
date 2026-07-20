import path from 'node:path';
import { stat } from 'node:fs/promises';
import { extractArchive } from '../archive/extract.js';
import { readArchiveMetadata } from '../archive/metadata.js';
import { evaluateArchiveRisks } from '../archive/risk.js';
import { createPlanPatch } from '../patch/create.js';
import { isLocalLlmEnabled } from '../llm/generate.js';
import { updateManagedHistory } from '../history/managed.js';
import { buildUpdatePlan } from '../plan/build.js';
import { applyUpdatePlan } from '../apply/apply.js';
import { acquireProjectLock } from '../apply/lock.js';
import { createCommit } from '../git/repository.js';
import { createRunId } from '../utils/id.js';
import { exists } from '../utils/fs.js';
import { hashFile } from '../utils/hash.js';
import { displayPath, parseEnteredPath } from '../utils/paths.js';
import { getZipflowHome } from '../workflow/store.js';
import { createRunRecord, findAppliedArchiveRun, saveRunRecord } from '../runs/store.js';
import { compactPlanLine, formatArchiveName, planActivityLines } from '../ui/format.js';
import {
  activatePostCheck, backPostCheck, isPostCheckScreen, startChecks, submitPostCheckEditor,
} from './run-postcheck.js';
import {
  activateRollback, backRollback, confirmRollback, showLastRun, showRunDetails,
} from './run-rollback.js';
import { cancelRun, failRun } from './run-lifecycle.js';
import {
  activateReview, archiveConflictPaths, backReview, handleReviewKey, handlesReviewScreen,
  showArchiveSafetyReview, showConflictCheckpoint, showConflictSummary, showPlanReview,
} from './run-review.js';
import { prepareArchiveRootReview, selectArchiveRoot, showArchiveRootChoice } from './archive-root.js';
import { activeRunSettings, captureRunSettings } from './runtime-settings.js';
import { skipPendingLlmReview, startLlmReview } from './run-llm-review.js';
import { recentArchiveHint, rememberArchivePath } from '../settings/recent.js';

export { showLastRun };

export function handlesRunScreen(screen) {
  return ['archive-input', 'archive-duplicate', 'archive-root-choice', 'applying', 'run-details', 'run-file-groups', 'run-file-list', 'rollback-confirm', 'rolling-back'].includes(screen)
    || handlesReviewScreen(screen) || isPostCheckScreen(screen);
}

export function beginArchiveInput(controller) {
  controller.state.pendingArchive = null;
  controller.showEditor('archive-input', {
    label: 'ZIP archive path',
    placeholder: '~/Downloads/project-update.zip',
    purpose: 'archive-path',
    instructions: [
      'Drop a ZIP file into the terminal or enter its path. Tab completes ZIP paths; on an empty field it opens recent archives.',
      ...(recentArchiveHint(controller.state.settings) ? [recentArchiveHint(controller.state.settings)] : []),
      'Next: Zipflow compares it with the project, creates changes.patch, and shows a compact review before any files change.',
    ],
  }, '');
  controller.setStatus('Step 1 of 5 · Choose archive');
}

export async function submitRunEditor(controller) {
  if (controller.state.editorContext?.purpose === 'archive-path') return inspectArchivePath(controller, controller.state.editor.value);
  return submitPostCheckEditor(controller);
}

export async function activateRun(controller, itemId) {
  const { state } = controller;
  if (state.screen === 'archive-duplicate') return activateDuplicate(controller, itemId);
  if (state.screen === 'archive-root-choice') return activateArchiveRootChoice(controller, itemId);
  if (handlesReviewScreen(state.screen)) {
    return activateReview(controller, itemId, {
      startApply,
      cancelRun,
      retryArchive,
      createCheckpoint,
      continueAfterSafety,
      skipPendingLlmReview,
    });
  }
  if (isPostCheckScreen(state.screen)) return activatePostCheck(controller, itemId);
  if (['run-details', 'run-file-groups', 'run-file-list', 'rollback-confirm'].includes(state.screen)) {
    const result = await activateRollback(controller, itemId);
    if (result !== false) return result;
    if (itemId === 'another-archive') return beginArchiveInput(controller);
  }
}

export function handleRunShortcut(controller, key) {
  return handleReviewKey(controller, key);
}

export function backRun(controller) {
  const screen = controller.state.screen;
  if (screen === 'archive-input' || screen === 'archive-duplicate') return controller.showHome();
  if (screen === 'archive-root-choice') return cancelRun(controller);
  if (screen === 'archive-safety' || screen === 'plan-review' || screen === 'conflict-summary') return cancelRun(controller);
  if (handlesReviewScreen(screen)) return backReview(controller);
  if (isPostCheckScreen(screen)) return backPostCheck(controller);
  if (['run-details', 'run-file-groups', 'run-file-list', 'rollback-confirm'].includes(screen)) return backRollback(controller);
  return false;
}

export async function inspectArchivePath(controller, enteredPath, { allowDuplicate = false, archiveHash = null } = {}) {
  const { state } = controller;
  const archivePath = parseEnteredPath(enteredPath, state.project.root);
  if (!(await exists(archivePath))) return controller.message('Archive not found', [displayPath(archivePath)], 'error');
  if (!archivePath.toLowerCase().endsWith('.zip')) return controller.message('Unsupported archive', ['Zipflow currently accepts .zip files only.'], 'error');
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile()) return controller.message('Archive path is not a file', [displayPath(archivePath)], 'error');
  const archiveInfo = { size: archiveStat.size, modifiedAt: archiveStat.mtime.toISOString() };
  await rememberArchivePath(state, archivePath);
  const digest = archiveHash ?? await hashFile(archivePath);
  if (!allowDuplicate) {
    const previous = await findAppliedArchiveRun(state.project.root, digest);
    if (previous) return showDuplicateWarning(controller, archivePath, digest, previous);
  }
  return inspectArchive(controller, archivePath, digest, archiveInfo);
}

async function inspectArchive(controller, archivePath, archiveHash, archiveInfo) {
  const { state } = controller;
  const runId = createRunId();
  state.pendingArchive = null;
  try {
    state.run = await createRunRecord({ id: runId, project: state.project, workflow: state.workflow, archivePath, archiveHash, archiveInfo });
    captureRunSettings(state);
    state.run = await saveRunRecord(state.run);
    controller.activeLock = await acquireProjectLock(state.project.root, runId);
    const temp = path.join(getZipflowHome(), 'tmp', runId);
    setBusy(controller, 'Inspecting archive', 1, 7, 'Reading ZIP entries');
    const extracted = await extractArchive(archivePath, temp);
    const rootReview = await prepareArchiveRootReview({ project: state.project, workflow: state.workflow, extracted });
    if (rootReview.prompt) {
      state.pendingArchiveInspection = { archivePath, archiveHash, archiveInfo, rootReview };
      state.busy = false;
      return showArchiveRootChoice(controller, rootReview);
    }
    return continueArchiveInspection(controller, {
      archivePath,
      archiveHash,
      archiveInfo,
      extracted: rootReview.extracted,
      plan: rootReview.plan,
    });
  } catch (error) {
    await failRun(controller, error, {
      kind: 'archive',
      retry: () => inspectArchivePath(controller, archivePath, { allowDuplicate: true, archiveHash }),
    });
  }
}

async function continueArchiveInspection(controller, { archivePath, archiveHash, archiveInfo, extracted, plan = null }) {
  const { state } = controller;
  try {
    setBusy(controller, 'Inspecting archive', 2, 7, 'Reading archive metadata');
    const metadata = await readArchiveMetadata(extracted);
    setProgress(controller, 3, 7, 'Comparing project files');
    const resolvedPlan = plan ?? await buildUpdatePlan({ project: state.project, workflow: state.workflow, extracted });
    setProgress(controller, 4, 7, 'Creating changes.patch');
    const patch = await createPlanPatch(state.run.id, resolvedPlan);
    setProgress(controller, 5, 7, 'Checking deterministic archive risks');
    const archiveRisk = await evaluateArchiveRisks({
      projectPath: state.project.root,
      workflow: state.workflow,
      archiveInfo,
      extracted,
      plan: resolvedPlan,
    });

    state.archive = extracted;
    state.archiveMetadata = metadata;
    state.plan = resolvedPlan;
    state.decisions = new Map(resolvedPlan.conflicts.map((item) => [
      item.path,
      state.workflow.policy.conflictPolicy === 'overwrite' ? 'archive' : null,
    ]));
    state.run.plan = serializePlan(resolvedPlan);
    state.run.patch = { path: patch.path, omitted: patch.omitted };
    state.run.archiveInfo = { ...archiveInfo, fileCount: extracted.fileCount, totalSize: extracted.totalSize, rootPrefix: extracted.rootPrefix };
    state.run.llm = null;
    state.archiveSafety = {
      warnings: archiveRisk.warnings,
      llm: null,
      acknowledged: false,
    };
    state.run.archiveSafety = state.archiveSafety;
    state.run.archiveMetadata = metadata.commitMessage ? { commitMessage: metadata.commitMessage, source: metadata.commitMessageSource } : null;
    state.run.status = 'planned';
    state.run = await saveRunRecord(state.run);
    state.pendingArchiveInspection = null;
    setProgress(controller, 7, 7, 'Plan ready');
    state.busy = false;

    controller.message('Archive inspected', [
      `${formatArchiveName(archivePath)} · ${extracted.fileCount} files${extracted.rootPrefix ? ` · root ${extracted.rootPrefix}/` : ''}`,
      ...(metadata.commitMessageSource ? [`Commit message found: ${metadata.commitMessageSource}`] : []),
    ], 'success', { collapsedSummary: `Archive inspected · ${extracted.fileCount} files` });
    controller.message('Update plan', [...planActivityLines(resolvedPlan), `Patch: ${displayPath(patch.path)}`], resolvedPlan.conflicts.length ? 'warning' : 'info', {
      collapsedSummary: `Update plan · ${compactPlanLine(resolvedPlan)}`,
    });

    const settings = activeRunSettings(state);
    const shouldRunLlm = isLocalLlmEnabled(settings)
      && (changedCount(resolvedPlan) > 0 || settings.llmArchiveReview === 'structure');
    if (shouldRunLlm) startLlmReview(controller, { plan: resolvedPlan, patch, extracted });

    if (requiresSafetyReview(state.archiveSafety)) return showArchiveSafetyReview(controller);
    return continueAfterSafety(controller);
  } catch (error) {
    await failRun(controller, error, {
      kind: 'archive',
      retry: () => inspectArchivePath(controller, archivePath, { allowDuplicate: true, archiveHash }),
    });
  }
}

async function activateArchiveRootChoice(controller, itemId) {
  const pending = controller.state.pendingArchiveInspection;
  if (!pending) return cancelRun(controller);
  if (itemId === 'cancel-root-review') return cancelRun(controller);
  const selection = selectArchiveRoot(pending.rootReview, itemId);
  if (!selection) return false;
  controller.message('Archive root selected', [
    selection.useRoot
      ? `${pending.rootReview.wrapper}/ will be treated as the project root.`
      : `${pending.rootReview.wrapper}/ will remain a subdirectory inside the project.`,
  ], 'choice');
  return continueArchiveInspection(controller, {
    archivePath: pending.archivePath,
    archiveHash: pending.archiveHash,
    archiveInfo: pending.archiveInfo,
    extracted: selection.extracted,
    plan: selection.plan,
  });
}

export async function startApply(controller, { checkpointCreated = false } = {}) {
  const { state } = controller;
  try {
    if (state.llmReviewPending && activeRunSettings(state).llmArchiveReview !== 'disabled') return showPlanReview(controller);
    if (requiresSafetyReview(state.archiveSafety) && !state.archiveSafety.acknowledged) return showArchiveSafetyReview(controller);
    if (!checkpointCreated && state.workflow.git.checkpoint === 'ask' && archiveConflictPaths(state).length) return showConflictCheckpoint(controller);
    if (!checkpointCreated && state.workflow.git.checkpoint === 'auto' && archiveConflictPaths(state).length) await createCheckpoint(controller);
    if (changedCount(state.plan) === 0) {
      state.run.applied = { paths: [], changedPaths: [], backupPath: null, skippedConflicts: [] };
      state.run.status = 'applied';
      state.run = await saveRunRecord(state.run);
      controller.message('Nothing to apply', [`${state.plan.counts.unchanged} files already match the archive.`], 'success');
      return startChecks(controller);
    }
    setBusy(controller, 'Applying update', 0, Math.max(1, changedCount(state.plan)), 'Creating backup');
    const applied = await applyUpdatePlan({
      runId: state.run.id, projectPath: state.project.root, plan: state.plan, decisions: state.decisions,
      onProgress: (progress) => setProgress(controller, progress.current, progress.total, `${progress.stage}${progress.path ? ` · ${progress.path}` : ''}`),
    });
    const managedHistory = await updateManagedHistory(state.project.root, applied.applied, {
      enabled: activeRunSettings(state).managedHistoryPolicy !== 'disabled',
    });
    state.run.applied = {
      paths: applied.applied.map((item) => item.path),
      changedPaths: applied.applied.filter((item) => item.kind !== 'deleted').map((item) => item.path),
      backupPath: applied.backup.root,
      backupAvailable: true,
      skippedConflicts: applied.skippedConflicts.map((item) => item.path),
      preservedPaths: state.plan.preserved.map((item) => item.path),
    };
    state.run.managedHistory = managedHistory;
    state.run.status = 'applied';
    state.run = await saveRunRecord(state.run);
    controller.message('Update applied', [
      `${applied.applied.length} paths changed · ${applied.skippedConflicts.length} conflicts kept locally`,
      `${state.plan.preserved.length} snapshot paths preserved · Backup: ${displayPath(applied.backup.root)}`,
    ], 'success');
    state.busy = false;
    return startChecks(controller);
  } catch (error) {
    await failRun(controller, error);
  }
}

export async function createCheckpoint(controller) {
  const paths = archiveConflictPaths(controller.state);
  if (!paths.length) return;
  const message = `zipflow: checkpoint ${controller.state.run.id}`;
  const commit = await createCommit(controller.state.project.root, paths, message);
  if (!commit.ok) throw new Error(`Checkpoint commit failed: ${commit.reason}`);
  controller.state.run.checkpoint = { revision: commit.revision, message, paths };
  controller.state.run = await saveRunRecord(controller.state.run);
  controller.message('Checkpoint created', [`${commit.revision} ${message}`], 'success');
}

export async function retryArchive(controller) {
  await cancelRun(controller);
  controller.message('Ready for another archive', ['Choose the corrected or rebuilt ZIP file.']);
  return beginArchiveInput(controller);
}

function showDuplicateWarning(controller, archivePath, archiveHash, previous) {
  controller.state.pendingArchive = { archivePath, archiveHash, previous };
  controller.showMenu('archive-duplicate', [
    { id: 'duplicate-choose-another', label: 'Choose another archive', description: 'Recommended when this ZIP was selected accidentally' },
    { id: 'duplicate-apply-again', label: 'Apply this archive again', description: 'Rebuild the plan against the current project state' },
    { id: 'duplicate-view-run', label: 'Show previous result', description: `Run ${previous.id} · ${previous.status}` },
  ], 'Archive was used before', 0, [
    formatArchiveName(archivePath),
    `Previously used: ${new Date(previous.createdAt).toLocaleString('en-GB')}`,
    previous.plan?.counts ? compactPlanLine({ counts: previous.plan.counts }) : 'Previous plan unavailable',
  ]);
}

async function activateDuplicate(controller, itemId) {
  const pending = controller.state.pendingArchive;
  if (!pending) return beginArchiveInput(controller);
  if (itemId === 'duplicate-choose-another') return beginArchiveInput(controller);
  if (itemId === 'duplicate-apply-again') return inspectArchivePath(controller, pending.archivePath, { allowDuplicate: true, archiveHash: pending.archiveHash });
  if (itemId === 'duplicate-view-run') {
    const run = pending.previous;
    controller.message('Previous archive result', [
      `Run: ${run.id} · ${run.status}`,
      ...(run.plan?.counts ? [compactPlanLine({ counts: run.plan.counts })] : []),
      `Commit: ${run.commit ? `${run.commit.revision} ${firstLine(run.commit.message)}` : 'none'}`,
    ]);
    return showDuplicateWarning(controller, pending.archivePath, pending.archiveHash, run);
  }
}

function serializePlan(plan) {
  return {
    counts: plan.counts,
    created: plan.created.map((item) => item.path),
    updated: plan.updated.map((item) => item.path),
    deleted: plan.deleted.map((item) => item.path),
    preserved: plan.preserved.map((item) => ({ path: item.path, reason: item.reason })),
    unchanged: plan.unchanged.map((item) => item.path),
    conflicts: plan.conflicts.map((item) => ({ path: item.path, reason: item.reason })),
  };
}

export function continueAfterSafety(controller) {
  const { state } = controller;
  const plan = state.plan;
  if (plan.conflicts.length && state.workflow.policy.conflictPolicy !== 'overwrite') return showConflictSummary(controller);
  if (plan.conflicts.length) controller.message('Saved conflict policy applied', [`Archive versions selected for ${plan.conflicts.length} conflicts; each file will be backed up.`], 'warning');
  if (state.llmReviewPending || state.workflow.policy.confirmPlan || plan.skipped.length > 0 || (state.archiveSafety?.warnings?.length && !state.archiveSafety.acknowledged)) return showPlanReview(controller);
  controller.message('Safe plan accepted automatically', [compactPlanLine(plan), 'The saved workflow allows conflict-free plans to continue after the normal backup.'], 'choice');
  return startApply(controller);
}

function requiresSafetyReview(safety) {
  if (!safety) return false;
  if (safety.warnings?.length) return true;
  return ['suspicious', 'unsuitable'].includes(safety.llm?.assessment);
}

function setBusy(controller, label, value, total, detail) {
  controller.state.busy = true;
  controller.state.screen = 'applying';
  controller.state.busyLabel = label;
  controller.state.progress = { value, total, detail };
  controller.invalidate();
}

function setProgress(controller, value, total, detail) {
  controller.state.progress = { value, total: Math.max(1, total), detail };
  controller.invalidate();
}

function changedCount(plan) {
  return plan.created.length + plan.updated.length + plan.deleted.length;
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/, 1)[0];
}
