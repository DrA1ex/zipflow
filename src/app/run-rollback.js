import { inspectRollback, rollbackRun } from '../apply/rollback.js';
import { displayPath } from '../utils/paths.js';
import { loadRunRecord, runReportPath, saveRunRecord } from '../runs/store.js';
import { formatArchiveName, planSummary } from '../ui/format.js';
import { restoreManagedHistory } from '../history/managed.js';

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
  return showRunDetails(controller, run);
}

export function activateRollback(controller, itemId) {
  if (controller.state.screen === 'run-details') {
    if (itemId === 'rollback') return confirmRollback(controller, controller.state.run);
    if (itemId === 'another-archive') return false;
    if (itemId === 'back-home') return controller.showHome();
  }
  if (controller.state.screen === 'rollback-confirm') {
    if (itemId === 'rollback-now') return performRollback(controller);
    if (itemId === 'cancel-rollback') return showRunDetails(controller, controller.state.run);
  }
  return false;
}

export function backRollback(controller) {
  if (controller.state.screen === 'run-details') return controller.showHome();
  if (controller.state.screen === 'rollback-confirm') return showRunDetails(controller, controller.state.run);
  return false;
}

export function showRunDetails(controller, run) {
  const lines = [
    `Run: ${run.id}`,
    `Status: ${run.status}`,
    `Archive: ${formatArchiveName(run.archivePath)}`,
    `Source ZIP: ${archiveDispositionSummary(run.archiveDisposition)}`,
    ...(run.plan?.counts ? planSummary({ counts: run.plan.counts }) : []),
    `Checks: ${run.checks ? `${run.checks.passed} passed · ${run.checks.failed} failed` : 'not run'}`,
    `Commit: ${run.commit ? `${run.commit.revision} ${run.commit.message}` : 'none'}`,
    `Deploy: ${deploySummary(run.deploy)}`,
    `Report: ${displayPath(runReportPath(run.id))}`,
  ];
  controller.message('Run details', lines);
  const items = [];
  if (run.applied && run.rollback?.status !== 'completed') items.push({ id: 'rollback', label: 'Roll back this update' });
  items.push(
    { id: 'another-archive', label: 'Apply another archive' },
    { id: 'back-home', label: 'Back to project' },
  );
  controller.showMenu('run-details', items, 'Run details');
}

export async function confirmRollback(controller, run) {
  const inspection = await inspectRollback(run.id);
  if (!inspection.available) {
    controller.message('Rollback is not safe', [inspection.reason || `Changed after run: ${inspection.changedAfter.join(', ')}`], 'error');
    return showRunDetails(controller, run);
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
    return showRunDetails(controller, state.run);
  } catch (error) {
    state.busy = false;
    controller.message('Rollback failed', [error.message], 'error');
    return showRunDetails(controller, state.run);
  }
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
