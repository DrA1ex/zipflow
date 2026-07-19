import path from 'node:path';
import { chmod, copyFile, rm } from 'node:fs/promises';
import { ensureDir, exists, readJson } from '../utils/fs.js';
import { hashFile } from '../utils/hash.js';
import { getZipflowHome } from '../workflow/store.js';

export async function inspectRollback(runId) {
  const root = path.join(getZipflowHome(), 'backups', runId);
  const manifest = await readJson(path.join(root, 'manifest.json'), null);
  if (!manifest) return { available: false, reason: 'Backup manifest was not found.' };
  const changedAfter = [];
  for (const item of manifest.items) {
    const currentPath = path.join(manifest.projectPath, item.path);
    if (item.kind === 'deleted') {
      if (await exists(currentPath)) changedAfter.push(item.path);
      continue;
    }
    if (!(await exists(currentPath))) {
      changedAfter.push(item.path);
      continue;
    }
    if (await hashFile(currentPath) !== item.afterHash) changedAfter.push(item.path);
  }
  return { available: changedAfter.length === 0, changedAfter, manifest, root };
}

export async function rollbackRun(runId, { onProgress = null } = {}) {
  const inspection = await inspectRollback(runId);
  if (!inspection.available) {
    const reason = inspection.reason || `Files changed after the run: ${inspection.changedAfter.join(', ')}`;
    throw new Error(reason);
  }
  const { manifest, root } = inspection;
  let current = 0;
  for (const item of [...manifest.items].reverse()) {
    const currentPath = path.join(manifest.projectPath, item.path);
    if (!item.existed) {
      await rm(currentPath, { force: true });
    } else {
      const backupPath = path.join(root, 'files', item.path);
      await ensureDir(path.dirname(currentPath));
      await copyFile(backupPath, currentPath);
      if (item.mode) await chmod(currentPath, item.mode);
    }
    current += 1;
    onProgress?.({ current, total: manifest.items.length, path: item.path });
  }
  return { restored: manifest.items.length, manifest };
}
