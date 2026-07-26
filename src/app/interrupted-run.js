import { listProjectRuns, saveRunRecord } from '../runs/store.js';
import { clearRunSettings } from './runtime-settings.js';
import { confirmRollback, showRunDetails } from './run-rollback.js';
import { translateForState } from '../i18n/index.js';
import { runStatusLabel } from '../ui/format.js';

const TERMINAL_STATUSES = new Set([
  'completed', 'completed_with_errors', 'failed', 'cancelled', 'rolled_back', 'interrupted_closed', 'duplicate_skipped', 'no_changes',
]);

export async function offerInterruptedRunRecovery(controller) {
  const runs = await listProjectRuns(controller.state.project.root, { limit: 5 });
  const run = runs.find((item) => !item.kind && !TERMINAL_STATUSES.has(item.status));
  if (!run) return false;
  const wasAlreadyInterrupted = run.status === 'interrupted';
  run.interruptedFrom = run.interruptedFrom ?? (wasAlreadyInterrupted ? 'an earlier stage' : run.status);
  run.status = 'interrupted';
  run.interruptedAt ??= new Date().toISOString();
  for (const decision of run.decisions ?? []) {
    if (decision.source !== 'user' && ['pending', 'executing'].includes(decision.executionStatus)) {
      decision.executionStatus = 'interrupted';
      decision.executionError = 'Zipflow stopped before the decision action was confirmed as complete.';
    }
  }
  controller.state.run = await saveRunRecord(run);
  const interruptedStage = translateForState(controller.state, runStatusLabel(run.interruptedFrom));
  controller.message('Interrupted update detected', [
    `Run ${run.id} stopped during ${interruptedStage}.`,
    run.applied?.backupAvailable !== false && run.applied
      ? 'Changes from this run are already present in the project. Keep them to accept the update, or roll them back from the stored backup.'
      : 'No applied update was recorded for this run. Review the interrupted run, then close it without changing project files.',
  ], 'warning', { collapsedSummary: `Interrupted run · ${run.id} · ${run.interruptedFrom}` });
  showInterruptedRun(controller);
  return true;
}

export function showInterruptedRun(controller) {
  const run = controller.state.run;
  const applied = Boolean(run?.applied);
  controller.showMenu('interrupted-run', [
    { id: 'interrupted-details', label: 'Review interrupted run', context: 'Open the stored plan, report, changed files, and backup state before deciding.' },
    ...(applied ? [{ id: 'interrupted-keep', label: 'Keep applied update and close run', context: 'Accept the project files exactly as they are now and finish this interrupted run.' }] : []),
    ...(applied && run.applied?.backupAvailable !== false ? [{ id: 'interrupted-rollback', label: 'Roll back applied update', context: 'Restore the exact files captured before this update was applied.' }] : []),
    ...(!applied ? [{ id: 'interrupted-keep', label: 'Close interrupted run', context: 'Close the unfinished inspection without changing project files.' }] : []),
  ], 'Resolve interrupted update', 0, applied
    ? ['The update is already present in the project.', 'Choose Keep applied update to accept it, or Roll back to restore the previous files.']
    : ['No project update was applied.', 'Review the stored run or close it without changing files.']);
}

export async function activateInterruptedRun(controller, itemId) {
  const { state } = controller;
  if (itemId === 'interrupted-details') return showRunDetails(controller, state.run, { origin: 'interrupted' });
  if (itemId === 'interrupted-rollback') return confirmRollback(controller, state.run);
  if (itemId === 'interrupted-keep') {
    state.run.status = state.run.applied ? 'completed_with_errors' : 'interrupted_closed';
    state.run.recovery = {
      action: state.run.applied ? 'kept-current-state' : 'closed-without-apply',
      at: new Date().toISOString(),
    };
    state.run = await saveRunRecord(state.run);
    clearRunSettings(state);
    controller.message('Interrupted run closed', [
      state.run.applied ? 'The applied project files were accepted and the interrupted run was closed.' : 'No project files were changed by the interrupted run.',
    ], 'warning');
    return controller.showHome();
  }
  return false;
}
