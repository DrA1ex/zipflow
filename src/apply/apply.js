import path from 'node:path';
import { chmod, copyFile, rename, rm } from 'node:fs/promises';
import { createBackup } from './backup.js';
import { ensureDir, exists } from '../utils/fs.js';
import { hashFile } from '../utils/hash.js';

export async function applyUpdatePlan({ runId, projectPath, plan, decisions = new Map(), onProgress = null }) {
  const items = selectedItems(plan, decisions);
  await verifyPlanStillCurrent(items);
  onProgress?.({ stage: 'backup', current: 0, total: items.length });
  const backup = await createBackup({ runId, projectPath, items });
  let current = 0;
  try {
    for (const item of items.filter((entry) => entry.kind === 'deleted')) {
      await rm(item.currentPath, { force: true });
      current += 1;
      onProgress?.({ stage: 'delete', current, total: items.length, path: item.path });
    }
    for (const item of items.filter((entry) => entry.kind !== 'deleted')) {
      await ensureDir(path.dirname(item.currentPath));
      const temporary = `${item.currentPath}.zipflow-${process.pid}-${Date.now()}`;
      await copyFile(item.sourcePath, temporary);
      if (item.mode) await chmod(temporary, item.mode);
      await rename(temporary, item.currentPath);
      current += 1;
      onProgress?.({ stage: item.kind === 'created' ? 'create' : 'update', current, total: items.length, path: item.path });
    }
    await verifyApplied(items);
  } catch (error) {
    try {
      await restoreBackup(backup);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Applying the archive failed and the automatic recovery also failed: ${error.message}`);
    }
    throw new Error(`Applying the archive failed; all touched files were restored: ${error.message}`, { cause: error });
  }
  onProgress?.({ stage: 'verify', current: items.length, total: items.length });
  return {
    backup,
    applied: items,
    skippedConflicts: plan.conflicts.filter((item) => decisions.get(item.path) === 'keep'),
  };
}

function selectedItems(plan, decisions) {
  const conflictPaths = new Set(plan.conflicts.map((item) => item.path));
  return [...plan.created, ...plan.updated, ...plan.deleted].filter((item) => {
    if (!conflictPaths.has(item.path)) return true;
    return decisions.get(item.path) === 'archive';
  });
}

async function verifyPlanStillCurrent(items) {
  const changed = [];
  for (const item of items) {
    const present = await exists(item.currentPath);
    if (item.kind === 'created') {
      if (present) changed.push(item.path);
      continue;
    }
    if (!present || await hashFile(item.currentPath) !== item.beforeHash) changed.push(item.path);
  }
  if (changed.length) {
    throw new Error(`Project files changed after the plan was shown: ${changed.join(', ')}`);
  }
}

async function verifyApplied(items) {
  for (const item of items) {
    if (item.kind === 'deleted') {
      if (await exists(item.currentPath)) throw new Error(`Failed to delete ${item.path}`);
      continue;
    }
    const actual = await hashFile(item.currentPath);
    if (actual !== item.afterHash) throw new Error(`Verification failed for ${item.path}`);
  }
}

async function restoreBackup(backup) {
  for (const item of [...backup.manifest.items].reverse()) {
    const currentPath = path.join(backup.manifest.projectPath, item.path);
    if (!item.existed) {
      await rm(currentPath, { force: true });
      continue;
    }
    const backupPath = path.join(backup.root, 'files', item.path);
    await ensureDir(path.dirname(currentPath));
    await copyFile(backupPath, currentPath);
    if (item.mode) await chmod(currentPath, item.mode);
  }
}
