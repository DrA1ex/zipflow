import path from 'node:path';
import { chmod, rename, rm } from 'node:fs/promises';
import { createBackup } from './backup.js';
import { ensureDir, exists } from '../utils/fs.js';
import { hashFile } from '../utils/hash.js';
import { assertSafeProjectPath } from '../security/project-path.js';
import { throwIfCancelled } from '../operations/manager.js';
import { copyRegularFileNoFollow } from '../security/safe-file.js';
import { shortToken } from '../utils/hash.js';
import { selectedPlanItems } from '../app/plan-selection.js';

export async function applyUpdatePlan({ runId, projectPath, plan, decisions = new Map(), onProgress = null, signal = null, shouldCancel = () => false }) {
  const items = selectedPlanItems(plan, decisions);
  throwIfCancelled(signal);
  await verifyPlanStillCurrent(projectPath, items, signal);
  onProgress?.({ stage: 'backup', current: 0, total: items.length });
  const backup = await createBackup({ runId, projectPath, items, signal });
  if (shouldCancel()) throw Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' });
  let current = 0;
  try {
    for (const item of items.filter((entry) => entry.kind === 'deleted')) {
      throwIfCancelled(signal);
      const { target } = await assertSafeProjectPath(projectPath, item.path, { allowMissingLeaf: false });
      await rm(target, { force: true });
      current += 1;
      onProgress?.({ stage: 'delete', current, total: items.length, path: item.path });
      if (shouldCancel()) throw Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' });
    }
    for (const item of items.filter((entry) => entry.kind !== 'deleted')) {
      throwIfCancelled(signal);
      const { target } = await assertSafeProjectPath(projectPath, item.path);
      await ensureDir(path.dirname(target));
      await assertSafeProjectPath(projectPath, item.path);
      const temporary = `${target}.zipflow-${process.pid}-${shortToken(8)}.tmp`;
      try {
        await copyRegularFileNoFollow(item.sourcePath, temporary, { mode: item.mode || 0o644, signal, sourceLabel: 'Extracted archive file' });
        if (item.mode) await chmod(temporary, item.mode);
        await assertSafeProjectPath(projectPath, item.path);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      current += 1;
      onProgress?.({ stage: item.kind === 'created' ? 'create' : 'update', current, total: items.length, path: item.path });
      if (shouldCancel()) throw Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' });
    }
    await verifyApplied(projectPath, items, signal);
  } catch (error) {
    try {
      await restoreBackup(backup);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Applying the archive failed and the automatic recovery also failed: ${error.message}`);
    }
    const wrapped = new Error(`Applying the archive failed; all touched files were restored: ${error.message}`, { cause: error });
    wrapped.code = error.code;
    throw wrapped;
  }
  onProgress?.({ stage: 'verify', current: items.length, total: items.length });
  return {
    backup,
    applied: items,
    skippedConflicts: plan.conflicts.filter((item) => decisions.get(item.path) === 'keep'),
  };
}


async function verifyPlanStillCurrent(projectPath, items, signal) {
  const changed = [];
  for (const item of items) {
    throwIfCancelled(signal);
    const { target } = await assertSafeProjectPath(projectPath, item.path);
    const present = await exists(target);
    if (item.kind === 'created') {
      if (present) changed.push(item.path);
      continue;
    }
    if (!present || await hashFile(target) !== item.beforeHash) changed.push(item.path);
  }
  if (changed.length) {
    throw new Error(`Project files changed after the plan was shown: ${changed.join(', ')}`);
  }
}

async function verifyApplied(projectPath, items, signal) {
  for (const item of items) {
    throwIfCancelled(signal);
    const { target } = await assertSafeProjectPath(projectPath, item.path);
    if (item.kind === 'deleted') {
      if (await exists(target)) throw new Error(`Failed to delete ${item.path}`);
      continue;
    }
    const actual = await hashFile(target);
    if (actual !== item.afterHash) throw new Error(`Verification failed for ${item.path}`);
  }
}

async function restoreBackup(backup) {
  for (const item of [...backup.manifest.items].reverse()) {
    const { target: currentPath } = await assertSafeProjectPath(backup.manifest.projectPath, item.path);
    if (!item.existed) {
      await rm(currentPath, { force: true });
      continue;
    }
    const filesRoot = path.join(backup.root, 'files');
    const { target: backupPath } = await assertSafeProjectPath(filesRoot, item.path, { allowMissingLeaf: false, requireFile: true });
    await ensureDir(path.dirname(currentPath));
    await assertSafeProjectPath(backup.manifest.projectPath, item.path);
    const temporary = `${currentPath}.zipflow-restore-${process.pid}-${shortToken(8)}.tmp`;
    try {
      await copyRegularFileNoFollow(backupPath, temporary, { mode: item.mode || 0o600, sourceLabel: 'Backup file' });
      if (item.mode) await chmod(temporary, item.mode);
      await assertSafeProjectPath(backup.manifest.projectPath, item.path);
      await rename(temporary, currentPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
