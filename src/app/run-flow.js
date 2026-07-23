import path from 'node:path';
import { extractArchive } from '../archive/extract.js';
import { readArchiveMetadata } from '../archive/metadata.js';
import { evaluateArchiveRisks } from '../archive/risk.js';
import { createPlanPatch } from '../patch/create.js';
import { isLocalLlmEnabled } from '../llm/generate.js';
import { hasLlmChangeTasks, isLlmArchiveReviewEnabled } from '../llm/tasks.js';
import { updateManagedHistory } from '../history/managed.js';
import { buildUpdatePlan } from '../plan/build.js';
import { applyUpdatePlan } from '../apply/apply.js';
import { acquireProjectLock } from '../apply/lock.js';
import { createCheckpointRef } from '../git/repository.js';
import { createRunId } from '../utils/id.js';
import { exists } from '../utils/fs.js';
import { hashFile } from '../utils/hash.js';
import { displayPath, parseEnteredPath } from '../utils/paths.js';
import { inspectArchiveFile } from '../security/archive-input.js';
import { getZipflowHome } from '../workflow/store.js';
import { createRunRecord, findAppliedArchiveRun, saveRunRecord } from '../runs/store.js';
import { compactPlanLine, formatArchiveName, planActivityLines } from '../ui/format.js';
import { activateDuplicate, showDuplicateWarning } from './run-duplicate.js';
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
import { activeRunSettings, captureRunSettings, clearRunSettings } from './runtime-settings.js';
import { skipPendingLlmReview, startLlmReview, waitForPendingLlmReview } from './run-llm-review.js';
import { rememberArchivePath } from '../settings/recent.js';
import { decideAtGate, autonomyEnabledFor, markAutonomyDecision } from './autonomy-flow.js';
import { activateInterruptedRun, showInterruptedRun } from './interrupted-run.js';
import { getGitStatus } from '../git/repository.js';
import {
  gitStateValidator, handleLocalWorkAutonomy, resolveConflictsAutonomously,
  serializeGitStatus, serializePlanForDecision,
} from './run-plan-autonomy.js';

import { completeNoChangeRun } from './run-completion.js';
import { effectiveChangedCount, excludedPlanItems, initializePlanSelections, selectedPlanCounts } from './plan-selection.js';
import { handleEmptyArchiveEnter as handleArchiveDoubleEnter, selectedDiscoveredArchive } from './run-archive-discovery.js';

export { showLastRun };

export function handlesRunScreen(screen) {
  return ['archive-input', 'archive-discovery', 'archive-duplicate', 'archive-root-choice', 'interrupted-run', 'applying', 'run-details', 'run-decisions', 'run-file-groups', 'run-file-list', 'rollback-confirm', 'rolling-back'].includes(screen)
    || handlesReviewScreen(screen) || isPostCheckScreen(screen);
}

export function beginArchiveInput(controller) {
  controller.state.pendingArchive = null;
  controller.state.archiveDiscoveryTap = null;
  controller.state.archiveDiscoveryCandidates = [];
  controller.showEditor('archive-input', {
    label: 'ZIP archive path',
    placeholder: '~/Downloads/project-update.zip',
    purpose: 'archive-path',
    instructions: ['Drop a ZIP file into the terminal or enter its path.'],
  }, '');
  controller.setStatus('Step 1 of 5 · Choose archive');
}

export function handleEmptyArchiveEnter(controller, options = {}) {
  return handleArchiveDoubleEnter(controller, { ...options, returnToInput: () => beginArchiveInput(controller) });
}

export async function submitRunEditor(controller) {
  if (controller.state.editorContext?.purpose === 'archive-path') return inspectArchivePath(controller, controller.state.editor.value);
  return submitPostCheckEditor(controller);
}

export async function activateRun(controller, itemId) {
  const { state } = controller;
  if (state.screen === 'archive-discovery') {
    const candidate = selectedDiscoveredArchive(state, itemId);
    return candidate ? inspectArchivePath(controller, candidate.path) : beginArchiveInput(controller);
  }
  if (state.screen === 'archive-duplicate') return activateDuplicate(controller, itemId, { beginArchiveInput, inspectArchivePath });
  if (state.screen === 'archive-root-choice') return activateArchiveRootChoice(controller, itemId);
  if (state.screen === 'interrupted-run') return activateInterruptedRun(controller, itemId);
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
  if (['run-details', 'run-decisions', 'run-file-groups', 'run-file-list', 'rollback-confirm'].includes(state.screen)) {
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
  if (screen === 'archive-discovery') return beginArchiveInput(controller);
  if (screen === 'archive-root-choice') return cancelRun(controller);
  if (screen === 'interrupted-run') return showInterruptedRun(controller);
  if (screen === 'archive-safety' || screen === 'plan-review' || screen === 'conflict-summary') return cancelRun(controller);
  if (handlesReviewScreen(screen)) return backReview(controller);
  if (isPostCheckScreen(screen)) return backPostCheck(controller);
  if (['run-details', 'run-decisions', 'run-file-groups', 'run-file-list', 'rollback-confirm'].includes(screen)) return backRollback(controller);
  return false;
}

export async function inspectArchivePath(controller, enteredPath, { allowDuplicate = false, archiveHash = null } = {}) {
  const { state } = controller;
  const archivePath = parseEnteredPath(enteredPath, state.project.root);
  if (!(await exists(archivePath))) return controller.toast('Archive not found', 'error', 3, displayPath(archivePath));
  if (!archivePath.toLowerCase().endsWith('.zip')) return controller.toast('Unsupported archive', 'error', 3, 'Zipflow currently accepts .zip files only.');
  let inspectedArchive;
  try {
    inspectedArchive = await inspectArchiveFile(archivePath);
  } catch (error) {
    return controller.toast('Unsafe archive path', 'error', 4, error.message);
  }
  const operation = controller.beginOperation({ kind: 'archive-inspection', label: 'Inspecting archive' });
  setBusy(controller, 'Inspecting archive', 0, 7, 'Hashing archive');
  try {
    const archiveInfo = { size: inspectedArchive.size, modifiedAt: inspectedArchive.modifiedAt };
    await rememberArchivePath(state, archivePath);
    operation.update({ phase: 'Hashing archive' });
    const digest = archiveHash ?? await hashFile(archivePath, { signal: operation.signal });
    let previous = null;
    if (!allowDuplicate) {
      previous = await findAppliedArchiveRun(state.project.root, digest);
      if (previous && state.workflow.autonomy?.mode === 'manual') {
        state.busy = false;
        operation.finish();
        return showDuplicateWarning(controller, archivePath, digest, previous);
      }
      if (previous) controller.message('Previously applied archive detected', [
        `Run ${previous.id} used the same ZIP. Autopilot will rebuild the plan against the current project state.`,
      ], 'info', { collapsedSummary: `Repeated archive · comparing current project state` });
    }
    return inspectArchive(controller, archivePath, digest, archiveInfo, operation, previous);
  } catch (error) {
    operation.finish();
    if (error.code === 'cancelled') {
      controller.message('Archive inspection cancelled', ['No project files were changed.'], 'warning');
      return beginArchiveInput(controller);
    }
    throw error;
  }
}

async function inspectArchive(controller, archivePath, archiveHash, archiveInfo, operation, previousRun = null) {
  const { state } = controller;
  const runId = createRunId();
  state.pendingArchive = null;
  try {
    state.run = await createRunRecord({ id: runId, project: state.project, workflow: state.workflow, archivePath, archiveHash, archiveInfo });
    if (previousRun) state.run.repeatOf = previousRun.id;
    captureRunSettings(state);
    state.run = await saveRunRecord(state.run);
    controller.message(`Update run ${runId}`, [`Archive: ${formatArchiveName(archivePath)}`], 'run', { collapsible: false });
    controller.activeLock = await acquireProjectLock(state.project.root, runId);
    const temp = path.join(getZipflowHome(), 'tmp', runId);
    setBusy(controller, 'Inspecting archive', 1, 7, 'Reading ZIP entries');
    operation.update({ phase: 'Reading ZIP entries' });
    const extracted = await extractArchive(archivePath, temp, { signal: operation.signal });
    const rootReview = await prepareArchiveRootReview({ project: state.project, workflow: state.workflow, extracted });
    if (rootReview.prompt) {
      state.pendingArchiveInspection = { archivePath, archiveHash, archiveInfo, rootReview };
      state.busy = false;
      operation.finish();
      return showArchiveRootChoice(controller, rootReview);
    }
    return continueArchiveInspection(controller, {
      archivePath,
      archiveHash,
      archiveInfo,
      extracted: rootReview.extracted,
      plan: rootReview.plan,
      operation,
    });
  } catch (error) {
    operation.finish();
    if (error.code === 'cancelled') {
      controller.message('Archive inspection cancelled', ['No project files were changed.'], 'warning');
      await cancelRun(controller);
      return beginArchiveInput(controller);
    }
    await failRun(controller, error, {
      kind: 'archive',
      retry: () => inspectArchivePath(controller, archivePath, { allowDuplicate: true, archiveHash }),
    });
  }
}

async function continueArchiveInspection(controller, { archivePath, archiveHash, archiveInfo, extracted, plan = null, operation = null }) {
  const { state } = controller;
  const activeOperation = operation ?? controller.beginOperation({ kind: 'archive-inspection', label: 'Inspecting archive' });
  try {
    activeOperation.update({ phase: 'Reading archive metadata' });
    setBusy(controller, 'Inspecting archive', 2, 7, 'Reading archive metadata');
    const metadata = await readArchiveMetadata(extracted);
    if (activeOperation.signal.aborted) throw Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' });
    setProgress(controller, 3, 7, 'Comparing project files');
    activeOperation.update({ phase: 'Comparing project files' });
    const resolvedPlan = plan ?? await buildUpdatePlan({ project: state.project, workflow: state.workflow, extracted, signal: activeOperation.signal });
    const hasChanges = changedCount(resolvedPlan) > 0;
    setProgress(controller, 4, 7, hasChanges ? 'Creating changes.patch' : 'No file changes detected');
    activeOperation.update({ phase: hasChanges ? 'Creating changes.patch' : 'No file changes detected' });
    const patch = hasChanges
      ? await createPlanPatch(state.run.id, resolvedPlan, { projectPath: state.project.root, signal: activeOperation.signal })
      : { path: null, content: '', omitted: 0 };
    setProgress(controller, 5, 7, hasChanges ? 'Checking deterministic archive risks' : 'Preparing no-change result');
    const archiveRisk = hasChanges ? await evaluateArchiveRisks({
      projectPath: state.project.root,
      workflow: state.workflow,
      archiveInfo,
      extracted,
      plan: resolvedPlan,
    }) : { warnings: [] };

    state.archive = extracted;
    state.archiveMetadata = metadata;
    state.plan = resolvedPlan;
    initializePlanSelections(state, resolvedPlan);
    if (state.workflow.autonomy?.mode === 'manual' && state.workflow.policy.conflictPolicy === 'overwrite') {
      for (const conflict of resolvedPlan.conflicts) state.decisions.set(conflict.path, 'archive');
    }
    state.run.plan = serializePlanForDecision(resolvedPlan);
    state.run.patch = patch.path ? { path: patch.path, omitted: patch.omitted } : null;
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
    activeOperation.finish();

    controller.message('Archive inspected', [
      `${formatArchiveName(archivePath)} · ${extracted.fileCount} files${extracted.rootPrefix ? ` · root ${extracted.rootPrefix}/` : ''}`,
      ...(metadata.commitMessageSource ? [`Commit message found: ${metadata.commitMessageSource}`] : []),
    ], 'success', { collapsedSummary: `Archive inspected · ${extracted.fileCount} files` });
    controller.message('Update plan', [...planActivityLines(resolvedPlan), ...(patch.path ? [`Patch: ${displayPath(patch.path)}`] : [])], resolvedPlan.conflicts.length ? 'warning' : 'info', {
      collapsedSummary: `Update plan · ${compactPlanLine(resolvedPlan)}`,
    });

    if (!hasChanges) return completeNoChangeRun(controller);

    const settings = activeRunSettings(state);
    const shouldRunLlm = isLocalLlmEnabled(settings) && hasLlmChangeTasks(settings) && hasChanges;
    if (shouldRunLlm) startLlmReview(controller, { plan: resolvedPlan, patch, extracted });

    if (requiresSafetyReview(state.archiveSafety)) return showArchiveSafetyReview(controller);
    return continueAfterSafety(controller);
  } catch (error) {
    activeOperation.finish();
    if (error.code === 'cancelled') {
      controller.message('Archive inspection cancelled', ['No project files were changed.'], 'warning');
      await cancelRun(controller);
      return beginArchiveInput(controller);
    }
    await failRun(controller, error, {
      kind: 'archive',
      retry: () => inspectArchivePath(controller, archivePath, { allowDuplicate: true, archiveHash }),
    });
  } finally {
    activeOperation.finish();
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
  const operation = controller.beginOperation({
    kind: 'apply', label: 'Applying update', critical: true,
  });
  try {
    if (state.llmReviewPending && isLlmArchiveReviewEnabled(activeRunSettings(state))) return showPlanReview(controller);
    if (requiresSafetyReview(state.archiveSafety) && !state.archiveSafety.acknowledged) return showArchiveSafetyReview(controller);
    if (!checkpointCreated && state.workflow.git.checkpoint === 'ask' && archiveConflictPaths(state).length) return showConflictCheckpoint(controller);
    if (!checkpointCreated && state.workflow.git.checkpoint === 'auto' && archiveConflictPaths(state).length) await createCheckpoint(controller, { operation });
    if (effectiveChangedCount(state.plan, state.decisions) === 0) {
      return operation.handoff(() => completeNoChangeRun(controller, { reason: 'selection-empty' }));
    }
    setBusy(controller, 'Applying update', 0, Math.max(1, effectiveChangedCount(state.plan, state.decisions)), 'Creating backup');
    const applied = await applyUpdatePlan({
      runId: state.run.id, projectPath: state.project.root, plan: state.plan, decisions: state.decisions,
      signal: operation.signal,
      shouldCancel: operation.isCancellationRequested,
      onProgress: (progress) => {
        operation.update({ phase: progress.stage, critical: true });
        setProgress(controller, progress.current, progress.total, `${progress.stage}${progress.path ? ` · ${progress.path}` : ''}`);
      },
    });
    const managedHistory = await updateManagedHistory(state.project.root, applied.applied, {
      enabled: activeRunSettings(state).managedHistoryPolicy !== 'disabled',
    });
    const excluded = excludedPlanItems(state.plan, state.decisions);
    state.run.applied = {
      paths: applied.applied.map((item) => item.path),
      changedPaths: applied.applied.filter((item) => item.kind !== 'deleted').map((item) => item.path),
      counts: selectedPlanCounts(state.plan, state.decisions),
      excludedPaths: excluded.map((item) => item.path),
      backupPath: applied.backup.root,
      backupAvailable: true,
      skippedConflicts: applied.skippedConflicts.map((item) => item.path),
      preservedPaths: state.plan.preserved.map((item) => item.path),
    };
    state.run.managedHistory = managedHistory;
    state.run.status = 'applied';
    state.run = await saveRunRecord(state.run);
    controller.message('Update applied', [
      `${applied.applied.length} paths changed · ${excluded.length} kept local by review · ${applied.skippedConflicts.length} conflicts kept locally`,
      `${state.plan.preserved.length} snapshot paths preserved · Backup: ${displayPath(applied.backup.root)}`,
    ], 'success');
    state.busy = false;
    return operation.handoff(() => startChecks(controller));
  } catch (error) {
    state.busy = false;
    if (error.code === 'cancelled') {
      controller.message('Update cancelled', ['The active filesystem transaction was stopped and every touched path was restored from backup.'], 'warning');
      return cancelRun(controller);
    }
    await failRun(controller, error);
  } finally {
    operation.finish();
  }
}

export async function createCheckpoint(controller, { force = false, operation = null } = {}) {
  const ownOperation = operation ? null : controller.beginOperation({ kind: 'git-checkpoint', label: 'Creating Git checkpoint' });
  const activeOperation = operation ?? ownOperation;
  let paths = archiveConflictPaths(controller.state);
  if (!paths.length && force) {
    const status = await getGitStatus(controller.state.project.root).catch(() => null);
    paths = [...new Set([...(status?.staged ?? []), ...(status?.unstaged ?? [])].map((item) => item.path))].sort();
  }
  if (!paths.length) { ownOperation?.finish(); return; }
  const checkpoint = await createCheckpointRef(controller.state.project.root, controller.state.run.id, { signal: activeOperation.signal });
  if (!checkpoint.ok) throw new Error(`Checkpoint ref failed: ${checkpoint.reason}`);
  controller.state.run.checkpoint = {
    revision: checkpoint.revision,
    ref: checkpoint.ref,
    paths,
    preservesIndex: true,
  };
  controller.state.run = await saveRunRecord(controller.state.run);
  controller.message('Checkpoint created', [
    checkpoint.ref ? `${checkpoint.revision} · ${checkpoint.ref}` : 'No tracked local changes required a Git checkpoint.',
    'The working tree and user index were not modified; untracked conflicts remain protected by the normal file backup.',
  ], 'success');
  ownOperation?.finish();
}

export async function retryArchive(controller) {
  await cancelRun(controller);
  controller.message('Ready for another archive', ['Choose the corrected or rebuilt ZIP file.']);
  return beginArchiveInput(controller);
}

export async function continueAfterSafety(controller) {
  const { state } = controller;
  const plan = state.plan;
  const localWork = await handleLocalWorkAutonomy(controller);
  if (localWork === 'cancelled') return cancelRun(controller);
  if (localWork === false) return showPlanReview(controller);
  if (state.llmReviewPending && autonomyEnabledFor(state, 'decidePlanApplication')) {
    await waitForPendingLlmReview(controller);
  }
  const unresolvedConflicts = plan.conflicts.filter((item) => !state.decisions.get(item.path));
  if (unresolvedConflicts.length) {
    if (autonomyEnabledFor(state, 'decideConflicts')) {
      const resolved = await resolveConflictsAutonomously(controller);
      if (resolved === 'cancelled') return cancelRun(controller);
      if (!resolved) return showConflictSummary(controller);
    } else if (state.workflow.autonomy?.mode === 'manual' && state.workflow.policy.conflictPolicy === 'overwrite') {
      for (const conflict of unresolvedConflicts) state.decisions.set(conflict.path, 'archive');
      controller.message('Saved conflict policy applied', [`Archive versions selected for ${unresolvedConflicts.length} conflicts; each file will be backed up.`], 'warning');
    } else {
      return showConflictSummary(controller);
    }
  }

  if (autonomyEnabledFor(state, 'decidePlanApplication')) {
    const highRisk = Boolean(state.archiveSafety?.warnings?.length)
      || ['suspicious', 'unsuitable'].includes(state.archiveSafety?.llm?.assessment)
      || (state.workflow.autonomy.mode === 'guarded' && plan.conflicts.length > 0);
    if (highRisk && state.workflow.autonomy.mode === 'guarded') {
      controller.message('Guarded autopilot paused', ['Archive warnings, an adverse LLM verdict, or unresolved local conflicts require your review.'], 'warning');
      return showPlanReview(controller);
    }
    const beforeStatus = await getGitStatus(state.project.root).catch(() => null);
    const decision = await decideAtGate(controller, {
      gate: 'plan-application',
      capability: 'decidePlanApplication',
      allowedActions: ['apply', 'abort', 'ask-user'],
      fallback: 'ask-user',
      label: 'Autopilot is reviewing the update plan',
      context: {
        state: {
          plan: serializePlanForDecision(plan),
          archiveWarnings: state.archiveSafety?.warnings ?? [],
          llmAssessment: state.archiveSafety?.llm ?? null,
          gitStatus: serializeGitStatus(beforeStatus),
        },
        riskLevel: highRisk ? 'high' : plan.counts.deleted > 0 ? 'medium' : 'low',
        coverage: state.run.llm?.diagnostics?.delivery?.coverage ?? null,
        complete: !state.llmReviewPending,
      },
      validateDecision: gitStateValidator(state.project.root, beforeStatus),
    });
    if (decision.action === 'apply') {
      try {
        await markAutonomyDecision(controller, decision, 'executing');
        const result = await startApply(controller, { checkpointCreated: Boolean(state.run.checkpoint) });
        await markAutonomyDecision(controller, decision, 'executed', { result: 'apply-started' });
        return result;
      } catch (error) {
        await markAutonomyDecision(controller, decision, 'failed', { error }).catch(() => {});
        throw error;
      }
    }
    if (decision.action === 'abort') {
      await markAutonomyDecision(controller, decision, 'executing');
      const result = await cancelRun(controller);
      await markAutonomyDecision(controller, decision, 'executed', { result: 'run-cancelled' });
      return result;
    }
    return showPlanReview(controller);
  }
  if (state.llmReviewPending || state.workflow.policy.confirmPlan || plan.skipped.length > 0
    || (state.archiveSafety?.warnings?.length && !state.archiveSafety.acknowledged)) return showPlanReview(controller);
  controller.message('Safe plan accepted automatically', [compactPlanLine(plan), 'The saved workflow allows conflict-free plans to continue after the normal backup.'], 'choice');
  return startApply(controller, { checkpointCreated: Boolean(state.run.checkpoint) });
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

