import { acquireProjectLock } from '../apply/lock.js';
import { applyUpdatePlan } from '../apply/apply.js';
import { inspectRollback, rollbackRun } from '../apply/rollback.js';
import { updateManagedHistory, restoreManagedHistory } from '../history/managed.js';
import {
  excludedPlanItems,
  keptPlanConflictItems,
  selectedPlanCounts,
} from '../plan/selection.js';
import { executableDecisionMap } from './archive-runner.js';

export async function applyExecutablePlan({
  runId,
  projectPath,
  executable,
  managedHistoryEnabled = true,
  signal = null,
  shouldCancel = () => false,
  onProgress = null,
} = {}) {
  assertExecutable(executable, { runId, projectPath });
  const lock = await acquireMutationLock(projectPath, runId);
  try {
    const decisions = executableDecisionMap(executable);
    const applied = await applyUpdatePlan({
      runId,
      projectPath,
      plan: executable.plan,
      decisions,
      signal,
      shouldCancel,
      onProgress,
    });
    const managedHistory = await updateManagedHistory(projectPath, applied.applied, {
      enabled: managedHistoryEnabled,
    });
    const excluded = excludedPlanItems(executable.plan, decisions);
    return {
      applied: {
        paths: applied.applied.map((item) => item.path),
        changedPaths: applied.applied
          .filter((item) => item.kind !== 'deleted')
          .map((item) => item.path),
        counts: selectedPlanCounts(executable.plan, decisions),
        excludedPaths: excluded.map((item) => item.path),
        backupPath: applied.backup.root,
        backupAvailable: true,
        skippedConflicts: keptPlanConflictItems(executable.plan, decisions)
          .map((item) => item.path),
        preservedPaths: (executable.plan.preserved ?? []).map((item) => item.path),
      },
      managedHistory,
      transaction: {
        applied: applied.applied.map((item) => ({
          kind: item.kind,
          path: item.path,
          beforeHash: item.beforeHash ?? null,
          afterHash: item.afterHash ?? null,
        })),
        backupManifestVersion: applied.backup.manifest?.version ?? null,
      },
    };
  } finally {
    await lock.release();
  }
}

export async function inspectExecutableRollback({
  runId,
  projectPath,
  executable,
  signal = null,
} = {}) {
  assertExecutable(executable, { runId, projectPath, requirePlan: false });
  return inspectRollback(runId, { signal });
}

export async function rollbackExecutableRun({
  runId,
  projectPath,
  executable,
  managedHistory = null,
  signal = null,
  onProgress = null,
} = {}) {
  assertExecutable(executable, { runId, projectPath, requirePlan: false });
  const lock = await acquireMutationLock(projectPath, `${runId}:rollback`);
  try {
    const result = await rollbackRun(runId, { signal, onProgress });
    if (Array.isArray(managedHistory?.before)) {
      await restoreManagedHistory(projectPath, managedHistory.before);
    }
    return {
      status: 'completed',
      restored: result.restored,
      at: new Date().toISOString(),
    };
  } finally {
    await lock.release();
  }
}

async function acquireMutationLock(projectPath, runId) {
  try {
    return await acquireProjectLock(projectPath, runId);
  } catch (error) {
    if (error?.code !== 'project_locked') throw error;
    throw Object.assign(new Error('Another Zipflow operation owns this project.', { cause: error }), {
      code: 'OPERATION_BUSY',
      status: 409,
      expose: true,
      detail: 'Another Zipflow operation owns this project.',
    });
  }
}

function assertExecutable(executable, {
  runId,
  projectPath,
  requirePlan = true,
}) {
  if (
    executable?.version !== 1
    || executable.binding?.runId !== runId
    || executable.binding?.projectPath !== projectPath
    || (requirePlan && !executable.plan)
  ) {
    throw Object.assign(new Error('Run execution manifest binding is invalid.'), {
      code: 'SERVER_STORAGE_CORRUPT',
    });
  }
}
