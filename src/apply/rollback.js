import path from 'node:path';
import { chmod, rename, rm } from 'node:fs/promises';
import { ensureDir, exists, readJson } from '../utils/fs.js';
import { hashFile } from '../utils/hash.js';
import { getZipflowHome } from '../workflow/store.js';
import { loadRunRecord } from '../runs/store.js';
import { canonicalPath } from '../utils/paths.js';
import { normalizeRelative } from '../security/project-path.js';
import { assertSafeProjectPath } from '../security/project-path.js';
import { throwIfCancelled } from '../operations/manager.js';
import { copyRegularFileNoFollow } from '../security/safe-file.js';
import { shortToken } from '../utils/hash.js';

export async function inspectRollback(runId) {
  const root = path.join(getZipflowHome(), 'backups', runId);
  const manifest = await readJson(path.join(root, 'manifest.json'), null);
  if (!manifest) return { available: false, reason: 'Backup manifest was not found.' };
  await validateBackupManifest(runId, root, manifest);
  const changedAfter = [];
  for (const item of manifest.items) {
    const { target: currentPath, relative } = await assertSafeProjectPath(manifest.projectPath, item.path);
    if (item.kind === 'deleted') {
      if (await exists(currentPath)) changedAfter.push(relative);
      continue;
    }
    if (!(await exists(currentPath))) {
      changedAfter.push(relative);
      continue;
    }
    if (await hashFile(currentPath) !== item.afterHash) changedAfter.push(relative);
  }
  return { available: changedAfter.length === 0, changedAfter, manifest, root };
}

export async function rollbackRun(runId, { onProgress = null, signal = null } = {}) {
  const inspection = await inspectRollback(runId);
  if (!inspection.available) {
    const reason = inspection.reason || `Files changed after the run: ${inspection.changedAfter.join(', ')}`;
    throw new Error(reason);
  }
  const { manifest, root } = inspection;
  let current = 0;
  for (const item of [...manifest.items].reverse()) {
    throwIfCancelled(signal);
    const { target: currentPath, relative } = await assertSafeProjectPath(manifest.projectPath, item.path);
    if (!item.existed) {
      await rm(currentPath, { force: true });
    } else {
      const filesRoot = path.join(root, 'files');
      const { target: backupPath } = await assertSafeProjectPath(filesRoot, relative, { allowMissingLeaf: false, requireFile: true });
      await ensureDir(path.dirname(currentPath));
      const temporary = `${currentPath}.zipflow-rollback-${process.pid}-${shortToken(8)}.tmp`;
      try {
        await copyRegularFileNoFollow(backupPath, temporary, { mode: item.mode || 0o600, signal, sourceLabel: 'Backup file' });
        if (item.mode) await chmod(temporary, item.mode);
        await assertSafeProjectPath(manifest.projectPath, item.path);
        await rename(temporary, currentPath);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    }
    current += 1;
    onProgress?.({ current, total: manifest.items.length, path: relative });
  }
  return { restored: manifest.items.length, manifest };
}


async function validateBackupManifest(runId, root, manifest) {
  if (manifest.version !== 1 || manifest.runId !== runId || !Array.isArray(manifest.items)) {
    throw unsafeBackup('Backup manifest identity or format is invalid.');
  }
  const binding = await readJson(path.join(root, 'binding.json'), null);
  if (binding?.version !== 1 || binding.runId !== runId || !binding.projectPath) {
    throw unsafeBackup('Backup binding identity or format is invalid.');
  }
  const run = await loadRunRecord(runId);
  const [manifestProject, bindingProject, runProject] = await Promise.all([
    canonicalPath(manifest.projectPath).catch(() => null),
    canonicalPath(binding.projectPath).catch(() => null),
    run?.projectPath ? canonicalPath(run.projectPath).catch(() => null) : Promise.resolve(null),
  ]);
  if (!manifestProject || manifestProject !== bindingProject) {
    throw unsafeBackup('Backup manifest project does not match its immutable binding.');
  }
  if (run?.projectPath && manifestProject !== runProject) {
    throw unsafeBackup('Backup manifest project does not match the stored run.');
  }
  const expectedFilesRoot = path.join(root, 'files');
  if (path.resolve(manifest.filesRoot || expectedFilesRoot) !== path.resolve(expectedFilesRoot)) {
    throw unsafeBackup('Backup manifest points outside its managed storage directory.');
  }
  const seen = new Set();
  for (const item of manifest.items) {
    const relative = normalizeRelative(item?.path);
    if (seen.has(relative)) throw unsafeBackup(`Backup manifest contains a duplicate path: ${relative}`);
    seen.add(relative);
    if (!['created', 'updated', 'deleted'].includes(item.kind)) throw unsafeBackup(`Backup manifest contains an invalid operation for ${relative}.`);
  }
}

function unsafeBackup(message) {
  const error = new Error(message);
  error.code = 'unsafe_backup';
  return error;
}
