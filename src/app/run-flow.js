import path from 'node:path';
import { stat } from 'node:fs/promises';
import { extractArchive } from '../archive/extract.js';
import { readArchiveMetadata } from '../archive/metadata.js';
import { createPlanPatch } from '../patch/create.js';
import { generateChangeDescription, isLocalLlmEnabled } from '../llm/generate.js';
import { beginLlmProgress } from './llm-progress.js';
import { updateManagedHistory } from '../history/managed.js';
import { buildUpdatePlan } from '../plan/build.js';
import { applyUpdatePlan } from '../apply/apply.js';
import { acquireProjectLock } from '../apply/lock.js';
import { createCommit } from '../git/repository.js';
import { createRunId } from '../utils/id.js';
import { exists } from '../utils/fs.js';
import { displayPath, parseEnteredPath } from '../utils/paths.js';
import { getZipflowHome } from '../workflow/store.js';
import { createRunRecord, saveRunRecord } from '../runs/store.js';
import { formatArchiveName, planActivityLines, planDetailLines, planSummary } from '../ui/format.js';
import {
  activatePostCheck, backPostCheck, isPostCheckScreen, startChecks, submitPostCheckEditor,
} from './run-postcheck.js';
import {
  activateRollback, backRollback, confirmRollback, showLastRun, showRunDetails,
} from './run-rollback.js';
import { cancelRun, failRun } from './run-lifecycle.js';

export { showLastRun };

export function handlesRunScreen(screen) {
  return [
    'archive-input', 'plan-review', 'plan-details', 'conflict-summary', 'conflict-checkpoint', 'conflicts', 'applying',
    'run-details', 'rollback-confirm', 'rolling-back',
  ].includes(screen) || isPostCheckScreen(screen);
}

export function beginArchiveInput(controller) {
  controller.showEditor('archive-input', {
    label: 'ZIP archive path',
    placeholder: '~/Downloads/project-update.zip',
    purpose: 'archive-path',
    instructions: ['Drop a ZIP file into the terminal or enter its path. Tab completes ZIP paths.'],
  }, '');
  controller.setStatus('Waiting for archive');
}

export async function submitRunEditor(controller) {
  if (controller.state.editorContext?.purpose === 'archive-path') {
    return inspectArchive(controller, controller.state.editor.value);
  }
  return submitPostCheckEditor(controller);
}

export async function activateRun(controller, itemId) {
  const { state } = controller;
  if (state.screen === 'plan-review') {
    if (itemId === 'view-plan') return showPlanDetails(controller);
    if (itemId === 'apply-plan') return startApply(controller);
    if (itemId === 'cancel-run') return cancelRun(controller);
  }
  if (state.screen === 'plan-details') {
    if (itemId === 'back-to-plan') return showPlanReview(controller);
    if (itemId === 'apply-plan') return startApply(controller);
  }
  if (['conflict-summary', 'conflict-checkpoint', 'conflicts'].includes(state.screen)) return activateConflict(controller, itemId);
  if (isPostCheckScreen(state.screen)) return activatePostCheck(controller, itemId);
  if (['run-details', 'rollback-confirm'].includes(state.screen)) {
    const result = await activateRollback(controller, itemId);
    if (result !== false) return result;
    if (itemId === 'another-archive') return beginArchiveInput(controller);
  }
}

export function handleConflictShortcut(controller, key) {
  const { state } = controller;
  if (state.screen !== 'conflicts') return false;
  const selected = state.menuItems[state.selectedIndex];
  if (key.name === 'space' && selected?.id.startsWith('conflict:')) {
    const conflict = state.plan.conflicts[Number(selected.id.slice(9))];
    const current = state.decisions.get(conflict.path) ?? 'keep';
    state.decisions.set(conflict.path, current === 'keep' ? 'archive' : 'keep');
    showConflicts(controller, state.selectedIndex);
    return true;
  }
  return false;
}

export function backRun(controller) {
  const screen = controller.state.screen;
  if (screen === 'archive-input') return controller.showHome();
  if (screen === 'plan-review') return cancelRun(controller);
  if (screen === 'plan-details') return showPlanReview(controller);
  if (screen === 'conflict-summary') return cancelRun(controller);
  if (screen === 'conflict-checkpoint' || screen === 'conflicts') return showConflictSummary(controller);
  if (isPostCheckScreen(screen)) return backPostCheck(controller);
  if (['run-details', 'rollback-confirm'].includes(screen)) return backRollback(controller);
}

async function inspectArchive(controller, enteredPath) {
  const { state } = controller;
  const archivePath = parseEnteredPath(enteredPath, state.project.root);
  if (!(await exists(archivePath))) return controller.message('Archive not found', [displayPath(archivePath)], 'error');
  if (!archivePath.toLowerCase().endsWith('.zip')) return controller.message('Unsupported archive', ['Zipflow currently accepts .zip files only.'], 'error');
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile()) return controller.message('Archive path is not a file', [displayPath(archivePath)], 'error');
  const runId = createRunId();
  state.run = await createRunRecord({ id: runId, project: state.project, workflow: state.workflow, archivePath });
  controller.activeLock = await acquireProjectLock(state.project.root, runId);
  const temp = path.join(getZipflowHome(), 'tmp', runId);
  state.busy = true;
  state.screen = 'applying';
  state.busyLabel = 'Inspecting archive';
  state.progress = { value: 1, total: 5, detail: 'Reading ZIP entries' };
  controller.invalidate();
  try {
    const extracted = await extractArchive(archivePath, temp);
    state.progress = { value: 2, total: 7, detail: 'Reading archive metadata' };
    controller.invalidate();
    const metadata = await readArchiveMetadata(extracted);
    state.progress = { value: 3, total: 7, detail: 'Comparing project files' };
    controller.invalidate();
    const plan = await buildUpdatePlan({ project: state.project, workflow: state.workflow, extracted });
    state.progress = { value: 4, total: 7, detail: 'Creating changes.patch' };
    controller.invalidate();
    const patch = await createPlanPatch(runId, plan);
    let llmResult = null;
    let llmError = null;
    if (isLocalLlmEnabled(state.settings) && changedCount(plan) > 0) {
      state.progress = { value: 5, total: 7, detail: `Streaming summary from ${state.settings.llmModel}` };
      const progress = beginLlmProgress(controller);
      controller.invalidate();
      try {
        llmResult = await generateChangeDescription(
          { settings: state.settings, project: state.project, plan, patchContent: patch.content },
          { onEvent: progress.onEvent },
        );
      } catch (error) {
        llmError = error.message;
      } finally {
        progress.stop();
      }
    }
    state.progress = { value: 7, total: 7, detail: 'Plan ready' };
    state.archive = extracted;
    state.archiveMetadata = metadata;
    state.plan = plan;
    state.decisions = new Map(plan.conflicts.map((item) => [
      item.path,
      state.workflow.policy.conflictPolicy === 'overwrite' ? 'archive' : 'keep',
    ]));
    state.run.plan = serializePlan(plan);
    state.run.patch = { path: patch.path, omitted: patch.omitted };
    state.run.llm = llmResult ? {
      provider: state.settings.llmProvider,
      model: state.settings.llmModel,
      language: state.settings.llmLanguage,
      summary: llmResult.summary,
      commitMessage: llmResult.commitMessage || null,
      warning: llmResult.warning || null,
      diagnostics: llmResult.diagnostics || null,
    } : llmError ? {
      provider: state.settings.llmProvider,
      model: state.settings.llmModel,
      language: state.settings.llmLanguage,
      error: llmError,
    } : null;
    state.run.archiveMetadata = metadata.commitMessage ? {
      commitMessage: metadata.commitMessage,
      source: metadata.commitMessageSource,
    } : null;
    state.run.status = 'planned';
    state.run = await saveRunRecord(state.run);
    controller.message('Archive inspected', [
      `${formatArchiveName(archivePath)} · ${extracted.fileCount} files${extracted.rootPrefix ? ` · root ${extracted.rootPrefix}/` : ''}`,
      ...(metadata.commitMessageSource ? [`Commit message found: ${metadata.commitMessageSource}`] : []),
    ], 'success');
    if (llmResult) {
      controller.message('Local LLM summary', llmResult.summary, 'info');
      if (llmResult.warning) controller.message('Local LLM response needed fallback handling', [llmResult.warning], 'warning');
    }
    if (llmError) controller.message('Local LLM summary was not generated', [llmError, 'The update can continue; commit message fallbacks remain available.'], 'warning');
    controller.message('Update plan', [...planActivityLines(plan), `Patch: ${displayPath(patch.path)}`], plan.conflicts.length ? 'warning' : 'info');
    state.busy = false;
    if (plan.conflicts.length && state.workflow.policy.conflictPolicy !== 'overwrite') return showConflictSummary(controller);
    if (plan.conflicts.length) controller.message('Conflicts handled by saved policy', [`${plan.conflicts.length} local files will be backed up and overwritten.`], 'warning');
    const needsReview = state.workflow.policy.confirmPlan || plan.skipped.length > 0;
    if (needsReview) return showPlanReview(controller);
    return startApply(controller);
  } catch (error) {
    await failRun(controller, error);
  }
}

function showPlanReview(controller) {
  const plan = controller.state.plan;
  const notes = [];
  if (plan.ignoredIncoming.length) notes.push(`${plan.ignoredIncoming.length} incoming files are ignored by Git`);
  if (plan.preserved.length) notes.push(`${plan.preserved.length} local files are outside the selected deletion scope and will be kept`);
  if (!notes.length) notes.push('No conflicts found');
  controller.showMenu('plan-review', [
    { id: 'apply-plan', label: 'Apply update', description: notes.join(' · ') },
    { id: 'view-plan', label: 'View changed and preserved files', description: planSummary(plan).join(' · ') },
    { id: 'cancel-run', label: 'Cancel', description: 'The project has not been changed' },
  ], 'Review update plan');
}

function showPlanDetails(controller) {
  controller.message('Changed and preserved files', planDetailLines(controller.state.plan));
  controller.showMenu('plan-details', [
    { id: 'apply-plan', label: 'Apply update' },
    { id: 'back-to-plan', label: 'Back' },
  ], 'Changed files');
}

function showConflictSummary(controller) {
  const count = controller.state.plan.conflicts.length;
  controller.showMenu('conflict-summary', [
    {
      id: 'replace-all-conflicts',
      label: 'Replace all conflicting files',
      description: `Use archive versions for all ${count} conflicts after creating the normal Zipflow backup.`,
    },
    {
      id: 'keep-all-conflicts',
      label: 'Keep all local versions',
      description: 'Apply created and non-conflicting files, but leave every conflicting local file untouched.',
    },
    {
      id: 'choose-conflicts',
      label: 'Choose files manually',
      description: 'Review each conflicting path and decide whether the local or archive version wins.',
    },
    {
      id: 'retry-archive',
      label: 'Cancel and choose the archive again',
      description: 'Discard this plan without changing the project and return to ZIP selection.',
    },
  ], `${count} conflicts need a decision`);
}

function showConflicts(controller, selectedIndex = null) {
  const { state } = controller;
  const items = state.plan.conflicts.map((conflict, index) => ({
    id: `conflict:${index}`,
    label: `[${state.decisions.get(conflict.path) === 'archive' ? 'use archive' : 'keep local'}] ${conflict.path}`,
    description: conflict.reason,
  }));
  items.push(
    { id: 'continue-conflicts', label: 'Apply with these file decisions' },
    { id: 'back-conflict-summary', label: 'Back to conflict choices' },
    { id: 'retry-archive', label: 'Cancel and choose the archive again' },
  );
  controller.showMenu('conflicts', items, 'Choose conflicting files', selectedIndex);
}

function showConflictCheckpoint(controller) {
  controller.showMenu('conflict-checkpoint', [
    {
      id: 'checkpoint-replace',
      label: 'Create a checkpoint commit, then apply archive choices',
      description: 'Commit affected local files before applying archive versions.',
    },
    {
      id: 'replace-without-checkpoint',
      label: 'Apply archive choices without a checkpoint commit',
      description: 'The Zipflow file backup is still created and can restore the overwritten files.',
    },
    { id: 'back-conflict-summary', label: 'Back' },
  ], 'Protect local conflict changes with Git');
}

async function activateConflict(controller, itemId) {
  const { state } = controller;
  if (state.screen === 'conflict-summary') {
    if (itemId === 'replace-all-conflicts') {
      for (const conflict of state.plan.conflicts) state.decisions.set(conflict.path, 'archive');
      return state.workflow.git.checkpoint === 'ask' ? showConflictCheckpoint(controller) : startApply(controller);
    }
    if (itemId === 'keep-all-conflicts') {
      for (const conflict of state.plan.conflicts) state.decisions.set(conflict.path, 'keep');
      return startApply(controller);
    }
    if (itemId === 'choose-conflicts') return showConflicts(controller);
    if (itemId === 'retry-archive') return retryArchive(controller);
  }
  if (state.screen === 'conflict-checkpoint') {
    if (itemId === 'checkpoint-replace') {
      await createCheckpoint(controller);
      return startApply(controller, { checkpointCreated: true });
    }
    if (itemId === 'replace-without-checkpoint') return startApply(controller);
    if (itemId === 'back-conflict-summary') return showConflictSummary(controller);
  }
  if (itemId.startsWith('conflict:')) {
    const index = Number(itemId.slice(9));
    const conflict = state.plan.conflicts[index];
    state.decisions.set(conflict.path, state.decisions.get(conflict.path) === 'archive' ? 'keep' : 'archive');
    return showConflicts(controller, index);
  }
  if (itemId === 'continue-conflicts') {
    const archiveSelected = archiveConflictPaths(state).length > 0;
    return archiveSelected && state.workflow.git.checkpoint === 'ask' ? showConflictCheckpoint(controller) : startApply(controller);
  }
  if (itemId === 'back-conflict-summary') return showConflictSummary(controller);
  if (itemId === 'retry-archive') return retryArchive(controller);
}

async function retryArchive(controller) {
  await cancelRun(controller);
  controller.message('Ready for another archive', ['Choose the corrected or rebuilt ZIP file.']);
  return beginArchiveInput(controller);
}

async function startApply(controller, { checkpointCreated = false } = {}) {
  const { state } = controller;
  try {
    if (!checkpointCreated && state.workflow.git.checkpoint === 'auto' && archiveConflictPaths(state).length) {
      await createCheckpoint(controller);
    }
    if (changedCount(state.plan) === 0) {
      state.run.applied = { paths: [], changedPaths: [], backupPath: null, skippedConflicts: [] };
      state.run.status = 'applied';
      state.run = await saveRunRecord(state.run);
      controller.message('Nothing to apply', [`${state.plan.counts.unchanged} files already match the archive.`], 'success');
      return startChecks(controller);
    }
    state.busy = true;
    state.screen = 'applying';
    state.busyLabel = 'Applying update';
    state.progress = { value: 0, total: Math.max(1, changedCount(state.plan)), detail: 'Creating backup' };
    controller.invalidate();
    const applied = await applyUpdatePlan({
      runId: state.run.id,
      projectPath: state.project.root,
      plan: state.plan,
      decisions: state.decisions,
      onProgress: (progress) => {
        state.progress = { value: progress.current, total: progress.total, detail: `${progress.stage}${progress.path ? ` · ${progress.path}` : ''}` };
        controller.invalidate();
      },
    });
    const managedHistory = await updateManagedHistory(state.project.root, applied.applied);
    state.run.applied = {
      paths: applied.applied.map((item) => item.path),
      changedPaths: applied.applied.filter((item) => item.kind !== 'deleted').map((item) => item.path),
      backupPath: applied.backup.root,
      skippedConflicts: applied.skippedConflicts.map((item) => item.path),
      preservedPaths: state.plan.preserved.map((item) => item.path),
    };
    state.run.managedHistory = managedHistory;
    state.run.status = 'applied';
    state.run = await saveRunRecord(state.run);
    controller.message('Update applied', [
      `${applied.applied.length} files changed`,
      `${applied.skippedConflicts.length} conflicting files kept locally`,
      `${state.plan.preserved.length} snapshot files preserved locally`,
      `Backup: ${displayPath(applied.backup.root)}`,
    ], 'success');
    state.busy = false;
    return startChecks(controller);
  } catch (error) {
    await failRun(controller, error);
  }
}

async function createCheckpoint(controller) {
  const paths = archiveConflictPaths(controller.state);
  if (!paths.length) return;
  const message = `zipflow: checkpoint ${controller.state.run.id}`;
  const commit = await createCommit(controller.state.project.root, paths, message);
  if (!commit.ok) throw new Error(`Checkpoint commit failed: ${commit.reason}`);
  controller.state.run.checkpoint = { revision: commit.revision, message, paths };
  controller.state.run = await saveRunRecord(controller.state.run);
  controller.message('Checkpoint created', [`${commit.revision} ${message}`], 'success');
}

function archiveConflictPaths(state) {
  return state.plan.conflicts
    .filter((item) => state.decisions.get(item.path) === 'archive')
    .map((item) => item.path);
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

function changedCount(plan) {
  return plan.created.length + plan.updated.length + plan.deleted.length;
}
