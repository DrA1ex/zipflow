import { inspectRollback, rollbackRun } from '../apply/rollback.js';
import { copyTextToClipboard } from 'terlio.js';
import { displayPath } from '../utils/paths.js';
import { runTypeDescription, runTypeTag } from '../history/presentation.js';
import { loadRunRecord, runReportPath, saveRunRecord } from '../runs/store.js';
import { compactPlanLine, compactPlanMeta, formatArchiveName, planSummary, runStatusLabel } from '../ui/format.js';
import { restoreManagedHistory } from '../history/managed.js';
import { loadStoredFileDiff, runChangedGroups } from '../diff/stored-patch.js';
import { setScreen } from './state.js';
import { formatCompletionForClipboard } from '../runs/text-report.js';

export async function showLastRun(controller) {
  const runId = controller.state.workflow?.lastRunId;
  if (!runId) {
    controller.message('No previous run', ['This workflow has not applied an archive yet.']);
    return controller.showHome();
  }
  const run = await loadRunRecord(runId);
  if (!run) {
    controller.message('Run report is missing', [runId], 'warning');
    return controller.showHome();
  }
  controller.state.run = run;
  controller.state.runDetailsOrigin = 'home';
  return showRunDetails(controller, run, { origin: 'home' });
}

export async function activateRollback(controller, itemId) {
  if (controller.state.screen === 'run-details') {
    if (itemId === 'rollback') return confirmRollback(controller, controller.state.run);
    if (itemId === 'another-archive') return false;
    if (itemId === 'view-run-files') return showRunFileGroups(controller);
    if (itemId === 'view-run-diff') return showCompleteRunDiff(controller);
    if (itemId === 'view-run-decisions') return showRunDecisions(controller);
    if (itemId === 'copy-run-summary') {
      const copied = await copyTextToClipboard(formatCompletionForClipboard(controller.state.run), { output: controller.runtime?.output });
      return copied ? controller.toast('Run summary copied', 'success') : controller.setStatus('Clipboard transfer unavailable');
    }
    if (itemId === 'back-home') return returnFromDetails(controller);
  }
  if (controller.state.screen === 'run-decisions') {
    if (itemId.startsWith('run-decision:')) return showDecisionDetails(controller, Number(itemId.slice(13)));
    if (itemId === 'run-decisions-back') return showRunDetails(controller, controller.state.run, { origin: controller.state.runDetailsOrigin });
  }
  if (controller.state.screen === 'run-file-groups') {
    if (itemId.startsWith('run-group:')) return showRunFileList(controller, itemId.slice(10));
    if (itemId === 'run-files-back') return showRunDetails(controller, controller.state.run, { origin: controller.state.runDetailsOrigin });
  }
  if (controller.state.screen === 'run-file-list') {
    if (itemId.startsWith('run-file:')) return openStoredRunDiff(controller, decodeURIComponent(itemId.slice(9)));
    if (itemId === 'run-groups-back') return showRunFileGroups(controller);
  }
  if (controller.state.screen === 'rollback-confirm') {
    if (itemId === 'rollback-now') return performRollback(controller);
    if (itemId === 'cancel-rollback') return showRunDetails(controller, controller.state.run, { origin: controller.state.runDetailsOrigin });
  }
  return false;
}

export function backRollback(controller) {
  if (controller.state.screen === 'run-details') return returnFromDetails(controller);
  if (controller.state.screen === 'run-decisions') return showRunDetails(controller, controller.state.run, { origin: controller.state.runDetailsOrigin });
  if (controller.state.screen === 'run-file-groups') return showRunDetails(controller, controller.state.run, { origin: controller.state.runDetailsOrigin });
  if (controller.state.screen === 'run-file-list') return showRunFileGroups(controller);
  if (controller.state.screen === 'rollback-confirm') return showRunDetails(controller, controller.state.run, { origin: controller.state.runDetailsOrigin });
  return false;
}

export function showRunDetails(controller, run, { origin = null, announce = true } = {}) {
  controller.state.runDetailsOrigin = origin ?? controller.state.runDetailsOrigin ?? 'home';
  const lines = [
    `Run: ${run.id}`,
    `Type: ${runTypeTag(run)}${run.kind ? ` · ${manualActionLabel(run.kind)}` : ' · Archive update'}`,
    `Status: ${runStatusLabel(run.status)}`,
    `Decision mode: ${autonomyLabel(run.autonomy?.mode)}${run.autonomy?.paused ? ' · paused' : ''}`,
    ...(run.archivePath ? [`Archive: ${formatArchiveName(run.archivePath)}`, `Source ZIP: ${archiveDispositionSummary(run.archiveDisposition)}`] : []),
    ...(run.plan?.counts ? planSummary({ counts: run.plan.counts }) : []),
    `Checks: ${run.checks ? `${run.checks.passed} passed · ${run.checks.failed} failed` : 'not run'}`,
    `LLM: ${run.llm ? `${run.llm.error ? 'failed' : run.llm.cancelled ? 'cancelled' : 'completed'}${run.llm.durationMs ? ` · ${Math.round(run.llm.durationMs / 1000)}s` : ''}${run.llm.assessment ? ` · ${run.llm.assessment}` : ''}` : 'not run'}`,
    `Archive warnings: ${run.archiveSafety?.warnings?.length ?? 0}`,
    `Commit: ${run.commit ? `${run.commit.revision} ${firstLine(run.commit.message)}` : 'none'}`,
    `Deploy: ${deploySummary(run.deploy)}`,
    `Decisions: ${decisionSummary(run)}`,
    ...(run.applied ? [`Rollback: ${run.applied.backupAvailable === false ? `unavailable · backup removed (${run.applied.backupRemovalReason || 'storage cleanup'})` : 'available while the backup remains stored'}`] : []),
    `Report: ${displayPath(runReportPath(run.id))}`,
  ];
  if (announce) controller.message('Run details', lines);
  const items = [];
  if (run.plan?.counts) {
    items.push(
      { id: 'view-run-files', label: 'Changed files', description: 'Browse added, changed, and removed paths; Enter opens the stored diff' },
      { id: 'view-run-diff', label: 'Open complete diff', description: 'Browse every stored file diff without returning to the file list' },
      { id: 'copy-run-summary', label: 'Copy run summary', description: 'Copy changes, checks, commit, deployment, and report details' },
    );
  }
  if (run.decisions?.some?.((item) => item.gate)) {
    items.push({ id: 'view-run-decisions', label: 'Autopilot decisions', description: 'Review allowed actions, confidence, evidence, risks, drift, and execution status.' });
  }
  if (run.applied && run.applied.backupAvailable !== false && run.rollback?.status !== 'completed') {
    items.push({ id: 'rollback', label: 'Roll back this update' });
  }
  items.push(
    { id: 'another-archive', label: run.kind ? 'Start an update' : 'Apply another archive' },
    { id: 'back-home', label: controller.state.runDetailsOrigin === 'history' ? 'Back to run history' : controller.state.runDetailsOrigin === 'interrupted' ? 'Back to recovery' : 'Back to project' },
  );
  const intro = run.plan?.counts
    ? [`[${runTypeTag(run)}] Archive update`, compactPlanLine({ counts: run.plan.counts }), compactPlanMeta({ counts: run.plan.counts }), `Status: ${runStatusLabel(run.status)}`]
    : [`[${runTypeTag(run)}] ${runTypeDescription(run)}`, `Status: ${runStatusLabel(run.status)}`];
  controller.showMenu('run-details', items, 'Run details', 0, intro);
}

export async function confirmRollback(controller, run) {
  const inspection = await inspectRollback(run.id);
  if (!inspection.available) {
    controller.message('Rollback is not safe', [inspection.reason || `Changed after run: ${inspection.changedAfter.join(', ')}`], 'error');
    return showRunDetails(controller, run, { origin: controller.state.runDetailsOrigin });
  }
  controller.showMenu('rollback-confirm', [
    { id: 'rollback-now', label: 'Roll back now', description: `${inspection.manifest.items.length} paths will be restored` },
    { id: 'cancel-rollback', label: 'Cancel' },
  ], 'Confirm rollback');
}

export async function performRollback(controller, { automatic = false } = {}) {
  const { state } = controller;
  const operation = controller.beginOperation({ kind: 'rollback', label: 'Rolling back update', critical: true });
  state.busy = true;
  state.screen = 'rolling-back';
  state.busyLabel = 'Rolling back update';
  state.progress = { value: 0, total: 1, detail: 'Preparing' };
  controller.invalidate();
  try {
    const result = await rollbackRun(state.run.id, {
      signal: operation.signal,
      onProgress: (progress) => {
        state.progress = { value: progress.current, total: progress.total, detail: progress.path };
        controller.invalidate();
      },
    });
    if (state.run.managedHistory?.before) await restoreManagedHistory(state.run.projectPath, state.run.managedHistory.before);
    state.run.rollback = { status: 'completed', at: new Date().toISOString(), restored: result.restored };
    state.run.status = 'rolled_back';
    state.run = await saveRunRecord(state.run);
    state.busy = false;
    controller.message('Rollback completed', [`${result.restored} paths restored`], 'success');
    if (automatic) return { ok: true, run: state.run, restored: result.restored };
    return showRunDetails(controller, state.run, { origin: controller.state.runDetailsOrigin });
  } catch (error) {
    state.busy = false;
    controller.message('Rollback failed', [error.message], 'error');
    if (automatic) return { ok: false, error };
    return showRunDetails(controller, state.run, { origin: controller.state.runDetailsOrigin });
  } finally {
    operation.finish();
  }
}


function showRunDecisions(controller) {
  const decisions = controller.state.run.decisions?.filter?.((item) => item.gate) ?? [];
  const items = decisions.map((decision, index) => ({
    id: `run-decision:${index}`,
    label: `${decision.gate} · ${decision.action} · ${decision.executionStatus ?? 'unknown'}`,
    context: decision.summary ?? 'No decision summary was recorded.',
  }));
  items.push({ id: 'run-decisions-back', label: 'Back to run details' });
  controller.showMenu('run-decisions', items, 'Autopilot decisions', 0, [
    `${decisions.length} bounded decision${decisions.length === 1 ? '' : 's'} recorded`,
    'Every action was selected from a Zipflow-provided allowlist and revalidated before execution.',
  ]);
}

function showDecisionDetails(controller, index) {
  const decision = (controller.state.run.decisions?.filter?.((item) => item.gate) ?? [])[index];
  if (!decision) return showRunDecisions(controller);
  const confidence = decision.effectiveConfidence ?? decision.confidence;
  controller.message('Autopilot decision details', [
    `Gate: ${decision.gate}`,
    `Action: ${decision.action}${decision.proposedAction && decision.proposedAction !== decision.action ? ` · proposed ${decision.proposedAction}` : ''}`,
    `Execution: ${decision.executionStatus ?? 'unknown'}${decision.executionError ? ` · ${decision.executionError}` : ''}`,
    `Source: ${decision.source ?? 'llm'} · Model: ${decision.model ?? 'unknown'}`,
    `Confidence: ${confidence == null ? 'n/a' : `${Math.round(Number(confidence) * 100)}%`}`,
    `Allowed: ${(decision.allowedActions ?? []).join(', ') || 'not recorded'}`,
    '',
    decision.summary ?? 'No summary recorded.',
    ...(decision.evidence?.length ? ['', 'Evidence:', ...decision.evidence.map((item) => `• ${item}`)] : []),
    ...(decision.risks?.length ? ['', 'Risks:', ...decision.risks.map((item) => `• ${item}`)] : []),
    ...(decision.conditions?.length ? ['', 'Conditions:', ...decision.conditions.map((item) => `• ${item}`)] : []),
    ...(decision.stateDrift ? ['', 'Project state changed while the decision was pending; the proposed action was not executed.'] : []),
  ], decision.executionStatus === 'failed' || decision.stateDrift ? 'warning' : 'info', {
    collapsedSummary: `Autopilot · ${decision.gate} · ${decision.action} · ${decision.executionStatus ?? 'unknown'}`,
  });
  return showRunDecisions(controller);
}

function showRunFileGroups(controller) {
  const groups = runChangedGroups(controller.state.run);
  const items = groups.map((group) => ({
    id: `run-group:${group.id}`,
    label: `${group.label} · ${group.paths.length}`,
    description: 'Open the file list for this change type',
  }));
  if (!items.length) items.push({ id: 'run-files-empty', label: 'No changed files recorded', disabled: true });
  items.push({ id: 'run-files-back', label: 'Back to run details' });
  controller.showMenu('run-file-groups', items, 'Changed files', 0, [
    `Run ${controller.state.run.id}`,
    'Choose a group, then press Enter on a file to open its stored diff.',
  ]);
}

function showRunFileList(controller, groupId) {
  const group = runChangedGroups(controller.state.run).find((item) => item.id === groupId);
  if (!group) return showRunFileGroups(controller);
  controller.state.runFileGroup = groupId;
  const items = group.paths.map((filePath) => ({
    id: `run-file:${encodeURIComponent(filePath)}`,
    label: filePath,
    description: 'Enter to view unified or side-by-side diff',
  }));
  items.push({ id: 'run-groups-back', label: 'Back to change groups' });
  controller.showMenu('run-file-list', items, `${group.label} files`, 0, [`${group.paths.length} file${group.paths.length === 1 ? '' : 's'}`]);
}

async function openStoredRunDiff(controller, filePath) {
  const group = runChangedGroups(controller.state.run).find((item) => item.id === controller.state.runFileGroup);
  const files = (group?.paths ?? [filePath]).map((value) => ({ path: value }));
  return openStoredDiffWorkspace(controller, files, Math.max(0, files.findIndex((item) => item.path === filePath)));
}

async function showCompleteRunDiff(controller) {
  const files = runChangedGroups(controller.state.run).flatMap((group) => group.paths.map((value) => ({ path: value })));
  if (!files.length) {
    controller.toast('No stored file diffs are available', 'info');
    return showRunDetails(controller, controller.state.run, { origin: controller.state.runDetailsOrigin, announce: false });
  }
  return openStoredDiffWorkspace(controller, files, 0);
}

async function openStoredDiffWorkspace(controller, files, fileIndex) {
  const file = files[fileIndex] ?? files[0];
  const diff = await loadStoredFileDiff(controller.state.run, file.path);
  controller.state.diffView = {
    diff,
    source: 'stored',
    run: controller.state.run,
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
  setScreen(controller.state, 'diff-view', { status: `Stored diff · ${file.path}`, intro: [] });
  controller.invalidate();
}

async function returnFromDetails(controller) {
  if (controller.state.runDetailsOrigin === 'history') {
    const { showRunHistory } = await import('./history-flow.js');
    return showRunHistory(controller, controller.state.historyReturnIndex ?? null);
  }
  if (controller.state.runDetailsOrigin === 'interrupted') {
    const { showInterruptedRun } = await import('./interrupted-run.js');
    return showInterruptedRun(controller);
  }
  return controller.showHome();
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/, 1)[0];
}

function archiveDispositionSummary(value) {
  if (!value) return 'not processed';
  if (value.action === 'moved') return `moved to ${displayPath(value.path)}`;
  if (value.action === 'deleted') return 'deleted';
  if (value.action === 'kept') return 'left in place';
  if (value.action === 'failed') return `policy failed: ${value.error}`;
  return value.action;
}

function deploySummary(deploy) {
  if (!deploy) return 'not run';
  if (deploy.skipped) return 'skipped';
  return deploy.ok ? `passed (${deploy.commandText})` : `failed (${deploy.commandText})`;
}

function decisionSummary(run) {
  const autonomous = run.decisions?.filter?.((item) => item.gate) ?? [];
  const manual = run.decisions?.filter?.((item) => !item.gate) ?? [];
  const pending = autonomous.filter((item) => ['pending', 'interrupted'].includes(item.executionStatus)).length;
  return `${autonomous.length} autopilot${pending ? ` · ${pending} unresolved` : ''} · ${manual.length} manual`;
}

function autonomyLabel(mode) {
  if (mode === 'guarded') return 'Guarded autopilot';
  if (mode === 'full') return 'Full autopilot · Dangerous';
  return 'Manual';
}

function manualActionLabel(kind) {
  if (kind === 'manual-checks') return 'Manual tests against current project';
  if (kind === 'manual-deploy') return 'Manual deployment of current project';
  return String(kind);
}
