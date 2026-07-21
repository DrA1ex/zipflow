import { listProjectRuns, saveRunRecord } from '../runs/store.js';
import { clearRunSettings } from './runtime-settings.js';
import { confirmRollback, showRunDetails } from './run-rollback.js';

const TERMINAL_STATUSES = new Set([
  'completed', 'completed_with_errors', 'failed', 'cancelled', 'rolled_back', 'interrupted_closed', 'duplicate_skipped',
]);

export async function offerInterruptedRunRecovery(controller) {
  const runs = await listProjectRuns(controller.state.project.root, { limit: 5 });
  const run = runs.find((item) => !item.kind && !TERMINAL_STATUSES.has(item.status));
  if (!run) return false;
  run.interruptedFrom = run.status;
  run.status = 'interrupted';
  run.interruptedAt = new Date().toISOString();
  for (const decision of run.decisions ?? []) {
    if (decision.source !== 'user' && ['pending', 'executing'].includes(decision.executionStatus)) {
      decision.executionStatus = 'interrupted';
      decision.executionError = 'Zipflow stopped before the decision action was confirmed as complete.';
    }
  }
  controller.state.run = await saveRunRecord(run);
  controller.message('Interrupted update detected', [
    `Run ${run.id} stopped during ${run.interruptedFrom}.`,
    run.applied?.backupAvailable !== false && run.applied
      ? 'The local update may still be applied and its backup can be inspected before continuing.'
      : 'No applied update was recorded for this run.',
  ], 'warning', { collapsedSummary: `Interrupted run · ${run.id} · ${run.interruptedFrom}` });
  return showInterruptedRun(controller);
}

export function showInterruptedRun(controller) {
  const run = controller.state.run;
  const applied = Boolean(run?.applied);
  controller.showMenu('interrupted-run', [
    { id: 'interrupted-details', label: 'Review interrupted run', context: 'Open the stored plan, decisions, report, and backup state.' },
    ...(applied && run.applied?.backupAvailable !== false ? [{ id: 'interrupted-rollback', label: 'Roll back interrupted update', context: 'Restore the exact files captured before this run.' }] : []),
    { id: 'interrupted-keep', label: applied ? 'Keep current local state and close run' : 'Close interrupted run', context: applied ? 'Do not repeat any pending autonomous action; keep files exactly as they are now.' : 'Mark the unfinished inspection as closed without changing project files.' },
  ], 'Recover interrupted update', 0);
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
      state.run.applied ? 'Current local files were kept. Pending autonomous actions were not replayed.' : 'No project files were changed by the interrupted run.',
    ], 'warning');
    return controller.showHome();
  }
  return false;
}
