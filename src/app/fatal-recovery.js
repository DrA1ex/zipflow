import path from 'node:path';
import { ensureDir, writeJsonDurableAtomic } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';
import { saveRunRecord } from '../runs/store.js';
import { ZIPFLOW_VERSION } from '../version.js';

const TERMINAL_RUN_STATUSES = new Set([
  'completed', 'completed_with_errors', 'failed', 'cancelled', 'rolled_back',
  'interrupted_closed', 'duplicate_skipped', 'no_changes',
]);

export async function writeFatalRecoveryState(controller, error, {
  safeBoundaryReached = false,
  recordedAt = new Date().toISOString(),
} = {}) {
  const { state } = controller;
  const recovery = {
    version: 1,
    zipflowVersion: ZIPFLOW_VERSION,
    recordedAt,
    projectPath: state.project?.root ?? null,
    runId: state.run?.id ?? null,
    screen: state.screen,
    status: state.status,
    safeBoundaryReached: Boolean(safeBoundaryReached),
    operation: state.activeOperation ? {
      id: state.activeOperation.id,
      kind: state.activeOperation.kind,
      state: state.activeOperation.state,
      phase: state.activeOperation.phase,
      critical: state.activeOperation.critical,
      cancelRequested: state.activeOperation.cancelRequested,
    } : null,
    lockPath: controller.activeLock?.path ?? null,
    runRecordUpdated: false,
    error: {
      message: String(error?.message ?? error ?? 'Unknown fatal error.'),
      code: error?.code ?? null,
      stack: error?.stack ?? null,
    },
  };
  const directory = path.join(getZipflowHome(), 'recovery');
  await ensureDir(directory);
  const target = path.join(directory, 'fatal.json');
  await writeJsonDurableAtomic(target, recovery);
  if (state.run?.id && safeBoundaryReached) {
    const run = state.run;
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      run.interruptedFrom = run.interruptedFrom ?? run.status;
      run.status = 'interrupted';
      run.interruptedAt = recordedAt;
    }
    run.recovery = {
      ...(run.recovery ?? {}),
      action: 'fatal-error',
      at: recordedAt,
      safeBoundaryReached: Boolean(safeBoundaryReached),
      error: recovery.error,
    };
    state.run = await saveRunRecord(run);
    recovery.runRecordUpdated = true;
    await writeJsonDurableAtomic(target, recovery);
  }
  return { path: target, recovery };
}
