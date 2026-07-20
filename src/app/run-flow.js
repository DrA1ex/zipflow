import path from 'node:path';
import { stat } from 'node:fs/promises';
import { extractArchive } from '../archive/extract.js';
import { readArchiveMetadata } from '../archive/metadata.js';
import { evaluateArchiveRisks } from '../archive/risk.js';
import { createPlanPatch } from '../patch/create.js';
import { generateChangeDescription, isLocalLlmEnabled } from '../llm/generate.js';
import { reviewArchiveStructure } from '../llm/archive-review.js';
import { resolveLocalLlmSession } from '../llm/session.js';
import { saveLlmDiagnostics } from '../llm/diagnostics.js';
import { beginLlmProgress } from './llm-progress.js';
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
import { createRunRecord, findAppliedArchiveRun, listProjectRuns, saveRunRecord } from '../runs/store.js';
import { buildRunAnalytics } from '../history/analytics.js';
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
      'Drop a ZIP file into the terminal or enter its path. Tab completes ZIP paths.',
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
  state.run = await createRunRecord({ id: runId, project: state.project, workflow: state.workflow, archivePath, archiveHash, archiveInfo });
  controller.activeLock = await acquireProjectLock(state.project.root, runId);
  const temp = path.join(getZipflowHome(), 'tmp', runId);
  setBusy(controller, 'Inspecting archive', 1, 7, 'Reading ZIP entries');
  try {
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
    await failRun(controller, error);
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
    const llm = await generateLlmSummary(controller, { plan: resolvedPlan, patch, extracted });
    const archiveRisk = await evaluateArchiveRisks({
      projectPath: state.project.root,
      workflow: state.workflow,
      archiveInfo,
      extracted,
      plan: resolvedPlan,
    });
    setProgress(controller, 7, 7, 'Plan ready');
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
    state.run.llm = llm.record;
    state.archiveSafety = {
      warnings: archiveRisk.warnings,
      llm: llm.assessment ?? null,
      acknowledged: false,
    };
    state.run.archiveSafety = state.archiveSafety;
    state.run.archiveMetadata = metadata.commitMessage ? { commitMessage: metadata.commitMessage, source: metadata.commitMessageSource } : null;
    state.run.status = 'planned';
    state.run = await saveRunRecord(state.run);
    state.pendingArchiveInspection = null;
    controller.message('Archive inspected', [
      `${formatArchiveName(archivePath)} · ${extracted.fileCount} files${extracted.rootPrefix ? ` · root ${extracted.rootPrefix}/` : ''}`,
      ...(metadata.commitMessageSource ? [`Commit message found: ${metadata.commitMessageSource}`] : []),
    ], 'success');
    controller.message('Update plan', [...planActivityLines(resolvedPlan), `Patch: ${displayPath(patch.path)}`], resolvedPlan.conflicts.length ? 'warning' : 'info');
    emitLlmResult(controller, llm, state.settings.llmArchiveReview);
    state.busy = false;
    if (requiresSafetyReview(state.archiveSafety)) return showArchiveSafetyReview(controller);
    return continueAfterSafety(controller);
  } catch (error) {
    await failRun(controller, error);
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

async function generateLlmSummary(controller, { plan, patch, extracted }) {
  const { state } = controller;
  if (!isLocalLlmEnabled(state.settings)) return { record: null, assessment: null };
  if (changedCount(plan) === 0 && state.settings.llmArchiveReview !== 'structure') return { record: null, assessment: null };
  setProgress(controller, 5, 7, `Streaming summary from ${state.settings.llmModel}`);
  const llmEstimate = await previousLlmEstimate(state);
  controller.message('Local LLM analysis starting', [
    `${changedCount(plan)} changed paths · delivery ${deliveryLabel(state.settings.llmChangeDelivery)}${state.settings.llmArchiveReview === 'structure' ? ' · project/archive structure guard first' : ''}${llmEstimate ? ` · historical median ${formatEstimate(llmEstimate)}` : ''}.`,
    'Adaptive delivery uses one patch when it fits and file-by-file batches when it does not. Esc cancels only this LLM step.',
  ], 'process');
  const progress = beginLlmProgress(controller, { expectedMs: llmEstimate });
  const abortController = new AbortController();
  state.llmAbortController = abortController;
  controller.invalidate();
  const startedAt = Date.now();
  try {
    progress.onEvent({ type: 'phase', phase: 'model-info', label: 'Reading the selected model context limit' });
    const session = await resolveLocalLlmSession(state.settings, { signal: abortController.signal });
    progress.onEvent({ type: 'model-profile', profile: session.profile });
    let structureAssessment = null;
    if (state.settings.llmArchiveReview === 'structure') {
      structureAssessment = await reviewArchiveStructure(
        { settings: state.settings, project: state.project, workflow: state.workflow, extracted, plan },
        { onEvent: progress.onEvent, signal: abortController.signal, session },
      );
      if (structureAssessment.assessment === 'unsuitable') {
        const result = { summary: structureAssessment.reasons, commitMessage: '', assessment: structureAssessment.assessment, confidence: structureAssessment.confidence, reasons: structureAssessment.reasons, diagnostics: { structure: structureAssessment.diagnostics } };
        const durationMs = Date.now() - startedAt;
        const diagnosticsPath = await saveLlmDiagnostics(state.run.id, {
          status: 'completed', provider: state.settings.llmProvider, model: state.settings.llmModel,
          diagnostics: result.diagnostics,
        }).catch(() => null);
        return { result, assessment: assessmentRecord(result, 'structure'), diagnosticsPath, record: llmRecord(state, result, diagnosticsPath, durationMs) };
      }
    }
    const result = await generateChangeDescription(
      { settings: state.settings, project: state.project, plan, patchContent: patch.content },
      { onEvent: progress.onEvent, signal: abortController.signal, session },
    );
    if (structureAssessment) {
      result.structureAssessment = structureAssessment;
      result.diagnostics = { ...(result.diagnostics ?? {}), structure: structureAssessment.diagnostics };
    }
    const durationMs = Date.now() - startedAt;
    const diagnosticsPath = await saveLlmDiagnostics(state.run.id, {
      status: 'completed', provider: state.settings.llmProvider, model: state.settings.llmModel,
      diagnostics: result.diagnostics ?? null, raw: result.raw ?? null,
    }).catch(() => null);
    const assessment = result.assessment
      ? assessmentRecord(result, 'patch')
      : result.structureAssessment
        ? assessmentRecord(result.structureAssessment, 'structure')
        : null;
    return { result, assessment, diagnosticsPath, record: llmRecord(state, result, diagnosticsPath, durationMs) };
  } catch (error) {
    const cancelled = error.code === 'cancelled';
    const diagnosticsPath = await saveLlmDiagnostics(state.run.id, {
      status: cancelled ? 'cancelled' : 'failed', provider: state.settings.llmProvider,
      model: state.settings.llmModel, ...(cancelled ? {} : { error }),
    }).catch(() => null);
    return {
      cancelled,
      error: cancelled ? null : error.message,
      diagnosticsPath,
      assessment: null,
      record: cancelled
        ? { durationMs: Date.now() - startedAt, provider: state.settings.llmProvider, model: state.settings.llmModel, language: state.settings.llmLanguage, cancelled: true, diagnosticsPath }
        : { durationMs: Date.now() - startedAt, provider: state.settings.llmProvider, model: state.settings.llmModel, language: state.settings.llmLanguage, error: error.message, diagnosticsPath },
    };
  } finally {
    if (state.llmAbortController === abortController) state.llmAbortController = null;
    progress.stop();
  }
}

function emitLlmResult(controller, llm, reviewMode) {
  if (llm.result) {
    const attempt = llm.result.diagnostics?.attempts?.find((item) => typeof item.attempt === 'number');
    if (attempt?.patch?.truncated) controller.message('Local LLM input reduced safely', [
      `Estimated ${attempt.patch.originalEstimatedTokens.toLocaleString('en-US')} tokens · sent ${attempt.patch.sentEstimatedTokens.toLocaleString('en-US')}`,
      `${attempt.patch.omittedFiles} files without excerpts · ${attempt.patch.omittedHunks} hunks omitted`,
    ], 'warning');
    const assessment = llm.assessment;
    if (assessment) controller.message('Local LLM archive suitability', [
      `${assessment.assessment} · ${assessment.confidence} confidence · ${assessment.mode} review`,
      ...assessment.reasons,
    ], assessment.assessment === 'suitable' ? 'success' : 'warning');
    else controller.message('Local LLM archive suitability', [
      reviewMode === 'disabled'
        ? 'Not requested · Archive review is set to Summary only.'
        : 'No suitability verdict was returned; deterministic Zipflow safety checks remain active.',
    ], reviewMode === 'disabled' ? 'info' : 'warning');
    if (llm.result.warning) controller.message('Local LLM fallback used', [llm.result.warning], 'warning');
    if (llm.result.summary?.length) controller.message('Local LLM summary', llm.result.summary, 'summary');
  } else if (llm.cancelled) controller.message('Local LLM generation cancelled', ['The update continues with normal commit-message fallbacks.'], 'warning');
  else if (llm.error) controller.message('Local LLM summary was not generated', [
    llm.error,
    ...(llm.diagnosticsPath ? [`Diagnostics: ${displayPath(llm.diagnosticsPath)}`] : []),
    'The update can continue and project files have not been affected by this error.',
  ], 'warning');
}

export async function startApply(controller, { checkpointCreated = false } = {}) {
  const { state } = controller;
  try {
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

function llmRecord(state, result, diagnosticsPath, durationMs = 0) {
  return {
    durationMs, provider: state.settings.llmProvider, model: state.settings.llmModel, language: state.settings.llmLanguage,
    summary: result.summary, commitMessage: result.commitMessage || null, warning: result.warning || null,
    assessment: result.assessment ?? result.structureAssessment?.assessment ?? null,
    confidence: result.confidence ?? result.structureAssessment?.confidence ?? null,
    reasons: result.reasons ?? result.structureAssessment?.reasons ?? null,
    diagnostics: result.diagnostics || null, diagnosticsPath,
    contextText: result.contextText ?? null,
    delivery: result.diagnostics?.delivery ?? null,
  };
}

export function continueAfterSafety(controller) {
  const { state } = controller;
  const plan = state.plan;
  if (plan.conflicts.length && state.workflow.policy.conflictPolicy !== 'overwrite') return showConflictSummary(controller);
  if (plan.conflicts.length) controller.message('Saved conflict policy applied', [`Archive versions selected for ${plan.conflicts.length} conflicts; each file will be backed up.`], 'warning');
  if (state.workflow.policy.confirmPlan || plan.skipped.length > 0 || (state.archiveSafety?.warnings?.length && !state.archiveSafety.acknowledged)) return showPlanReview(controller);
  controller.message('Safe plan accepted automatically', [compactPlanLine(plan), 'The saved workflow allows conflict-free plans to continue after the normal backup.'], 'choice');
  return startApply(controller);
}

function requiresSafetyReview(safety) {
  if (!safety) return false;
  if (safety.warnings?.length) return true;
  return ['suspicious', 'unsuitable'].includes(safety.llm?.assessment);
}

function assessmentRecord(value, mode) {
  if (!value?.assessment) return null;
  return {
    mode,
    assessment: value.assessment,
    confidence: value.confidence ?? 'low',
    reasons: value.reasons ?? value.summary ?? [],
  };
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

async function previousLlmEstimate(state) {
  const runs = (await listProjectRuns(state.project.root, { limit: 40 })).filter((run) => run.id !== state.run.id);
  const analytics = buildRunAnalytics(runs);
  const sameModel = analytics.llm.byModel.find((item) => item.name === `${state.settings.llmProvider} · ${state.settings.llmModel}`);
  return sameModel?.medianMs || analytics.llm.total.medianMs || 0;
}


function deliveryLabel(value) {
  if (value === 'patch') return 'full patch';
  if (value === 'change-list') return 'changed paths only';
  if (value === 'chunked') return 'file-by-file chunks';
  return 'adaptive';
}

function formatEstimate(milliseconds) {
  if (milliseconds >= 60_000) return `${Math.max(1, Math.round(milliseconds / 60_000))} min`;
  return `${Math.max(1, Math.round(milliseconds / 1000))} sec`;
}

function changedCount(plan) {
  return plan.created.length + plan.updated.length + plan.deleted.length;
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/, 1)[0];
}
