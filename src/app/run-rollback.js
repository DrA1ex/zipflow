import { inspectRollback, rollbackRun } from '../apply/rollback.js';
import { displayPath } from '../utils/paths.js';
import { loadRunRecord, runReportPath, saveRunRecord } from '../runs/store.js';
import { compactPlanLine, compactPlanMeta, formatArchiveName, planSummary, runStatusLabel } from '../ui/format.js';
import { restoreManagedHistory } from '../history/managed.js';
import { loadStoredFileDiff, runChangedGroups, storedPatchActivityLines } from '../diff/stored-patch.js';
import { setScreen } from './state.js';

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
    if (itemId === 'back-home') return returnFromDetails(controller);
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
  if (controller.state.screen === 'run-file-groups') return showRunDetails(controller, controller.state.run, { origin: controller.state.runDetailsOrigin });
  if (controller.state.screen === 'run-file-list') return showRunFileGroups(controller);
  if (controller.state.screen === 'rollback-confirm') return showRunDetails(controller, controller.state.run, { origin: controller.state.runDetailsOrigin });
  return false;
}

export function showRunDetails(controller, run, { origin = null, announce = true } = {}) {
  controller.state.runDetailsOrigin = origin ?? controller.state.runDetailsOrigin ?? 'home';
  const lines = [
    `Run: ${run.id}`,
    `Status: ${runStatusLabel(run.status)}`,
    ...(run.kind ? [`Action: ${manualActionLabel(run.kind)}`] : []),
    ...(run.archivePath ? [`Archive: ${formatArchiveName(run.archivePath)}`, `Source ZIP: ${archiveDispositionSummary(run.archiveDisposition)}`] : []),
    ...(run.plan?.counts ? planSummary({ counts: run.plan.counts }) : []),
    `Checks: ${run.checks ? `${run.checks.passed} passed · ${run.checks.failed} failed` : 'not run'}`,
    `LLM: ${run.llm ? `${run.llm.error ? 'failed' : run.llm.cancelled ? 'cancelled' : 'completed'}${run.llm.durationMs ? ` · ${Math.round(run.llm.durationMs / 1000)}s` : ''}${run.llm.assessment ? ` · ${run.llm.assessment}` : ''}` : 'not run'}`,
    `Archive warnings: ${run.archiveSafety?.warnings?.length ?? 0}`,
    `Commit: ${run.commit ? `${run.commit.revision} ${firstLine(run.commit.message)}` : 'none'}`,
    `Deploy: ${deploySummary(run.deploy)}`,
    `Decisions: ${run.decisions?.length ?? 0}`,
    `Report: ${displayPath(runReportPath(run.id))}`,
  ];
  if (announce) controller.message('Run details', lines);
  const items = [];
  if (run.plan?.counts) {
    items.push(
      { id: 'view-run-files', label: 'Changed files', description: 'Browse added, changed, and removed paths; Enter opens the stored diff' },
      { id: 'view-run-diff', label: 'View complete diff in Activity', description: 'Append the stored changes.patch so it can be expanded and scrolled' },
    );
  }
  if (run.applied && run.rollback?.status !== 'completed') items.push({ id: 'rollback', label: 'Roll back this update' });
  items.push(
    { id: 'another-archive', label: run.kind ? 'Start an update' : 'Apply another archive' },
    { id: 'back-home', label: controller.state.runDetailsOrigin === 'history' ? 'Back to run history' : 'Back to project' },
  );
  const intro = run.plan?.counts
    ? [compactPlanLine({ counts: run.plan.counts }), compactPlanMeta({ counts: run.plan.counts }), `Status: ${runStatusLabel(run.status)}`]
    : [`Status: ${runStatusLabel(run.status)}`];
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

async function performRollback(controller) {
  const { state } = controller;
  state.busy = true;
  state.screen = 'rolling-back';
  state.busyLabel = 'Rolling back update';
  state.progress = { value: 0, total: 1, detail: 'Preparing' };
  controller.invalidate();
  try {
    const result = await rollbackRun(state.run.id, {
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
    return showRunDetails(controller, state.run, { origin: controller.state.runDetailsOrigin });
  } catch (error) {
    state.busy = false;
    controller.message('Rollback failed', [error.message], 'error');
    return showRunDetails(controller, state.run, { origin: controller.state.runDetailsOrigin });
  }
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
  const diff = await loadStoredFileDiff(controller.state.run, filePath);
  controller.state.diffView = {
    diff,
    mode: 'unified',
    scroll: 0,
    hunkIndex: 0,
    hunkCount: 1,
    hunkOffsets: [0],
    returnScreen: controller.state.screen,
    returnItems: controller.state.menuItems,
    returnIndex: controller.state.selectedIndex,
    returnStatus: controller.state.status,
    returnIntro: controller.state.panelIntro,
  };
  setScreen(controller.state, 'diff-view', { status: `Stored diff · ${filePath}`, intro: [] });
  controller.invalidate();
}

async function showCompleteRunDiff(controller) {
  const lines = await storedPatchActivityLines(controller.state.run);
  controller.message(`Run diff · ${controller.state.run.id}`, lines, 'diff');
  const message = controller.state.messages.at(-1);
  if (message?.collapsible) message.collapsed = false;
  controller.setStatus('Complete diff added to Activity');
  return showRunDetails(controller, controller.state.run, { origin: controller.state.runDetailsOrigin, announce: false });
}

async function returnFromDetails(controller) {
  if (controller.state.runDetailsOrigin === 'history') {
    const { showRunHistory } = await import('./history-flow.js');
    return showRunHistory(controller);
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

function manualActionLabel(kind) {
  if (kind === 'manual-checks') return 'Manual tests against current project';
  if (kind === 'manual-deploy') return 'Manual deployment of current project';
  return String(kind);
}
