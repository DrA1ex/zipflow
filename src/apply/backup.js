import path from 'node:path';
import { rename, rm, stat } from 'node:fs/promises';
import { ensureDir, exists, writeJsonAtomic } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';
import { canonicalPath } from '../utils/paths.js';
import { hashFile, shortToken } from '../utils/hash.js';
import { assertSafeProjectPath } from '../security/project-path.js';
import { throwIfCancelled } from '../operations/manager.js';
import { copyRegularFileNoFollow } from '../security/safe-file.js';

export async function createBackup({ runId, projectPath, items, signal = null }) {
  assertRunId(runId);
  const backupsRoot = path.join(getZipflowHome(), 'backups');
  const root = path.join(backupsRoot, runId);
  const temporaryRoot = path.join(backupsRoot, `.${runId}.${process.pid}.${shortToken(8)}.tmp`);
  const temporaryFilesRoot = path.join(temporaryRoot, 'files');
  const finalFilesRoot = path.join(root, 'files');
  await ensureDir(backupsRoot);
  if (await exists(root)) throw backupError('backup_exists', `A backup already exists for run ${runId}.`);
  await rm(temporaryRoot, { recursive: true, force: true });
  await ensureDir(temporaryFilesRoot);

  try {
    const manifestItems = [];
    for (const item of items) {
      throwIfCancelled(signal);
      const { target: currentPath, relative } = await assertSafeProjectPath(projectPath, item.path);
      const existed = await exists(currentPath);
      const { target: backupPath } = await assertSafeProjectPath(temporaryFilesRoot, relative);
      let mode = null;
      let backupHash = null;
      if (!existed && item.kind !== 'created') {
        throw backupIntegrityError(relative, 'the expected project file is missing');
      }
      if (existed) {
        if (!item.beforeHash) throw backupIntegrityError(relative, 'the plan does not contain an expected pre-apply hash');
        const sourceInfo = await stat(currentPath);
        if (!sourceInfo.isFile()) throw backupIntegrityError(relative, 'the project path is not a regular file');
        mode = sourceInfo.mode & 0o777;
        await ensureDir(path.dirname(backupPath));
        await copyRegularFileNoFollow(currentPath, backupPath, { mode: 0o600, signal, sourceLabel: 'Project backup source' });
        backupHash = await hashFile(backupPath, { signal });
        if (backupHash !== item.beforeHash) {
          throw backupIntegrityError(relative, `expected ${item.beforeHash}, copied ${backupHash}`);
        }
      }
      manifestItems.push({
        path: relative,
        kind: item.kind,
        existed,
        beforeHash: item.beforeHash,
        afterHash: item.afterHash,
        backupHash,
        mode,
      });
    }

    const canonicalProjectPath = await canonicalPath(projectPath);
    const createdAt = new Date().toISOString();
    const binding = {
      version: 2,
      runId,
      projectPath: canonicalProjectPath,
      createdAt,
    };
    const manifest = {
      version: 2,
      runId,
      projectPath: canonicalProjectPath,
      createdAt,
      filesRoot: finalFilesRoot,
      items: manifestItems,
    };
    await writeJsonAtomic(path.join(temporaryRoot, 'binding.json'), binding);
    await writeJsonAtomic(path.join(temporaryRoot, 'manifest.json'), manifest);
    if (await exists(root)) throw backupError('backup_exists', `A backup already exists for run ${runId}.`);
    await rename(temporaryRoot, root);
    return { root, manifest };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function verifyBackupFiles({ root, manifest, signal = null }) {
  const filesRoot = path.join(root, 'files');
  for (const item of manifest.items ?? []) {
    throwIfCancelled(signal);
    if (!item.existed) continue;
    const expected = item.backupHash ?? item.beforeHash;
    if (!expected) throw backupIntegrityError(item.path, 'the manifest does not contain an expected backup hash');
    let backupPath;
    try {
      ({ target: backupPath } = await assertSafeProjectPath(filesRoot, item.path, { allowMissingLeaf: false, requireFile: true }));
    } catch (error) {
      throw backupIntegrityError(item.path, `required backup file is unavailable: ${error.message}`);
    }
    const actual = await hashFile(backupPath, { signal });
    if (actual !== expected) throw backupIntegrityError(item.path, `expected ${expected}, found ${actual}`);
  }
  return true;
}

export function backupIntegrityError(relative, details) {
  return backupError('backup_integrity', `Backup integrity check failed for ${relative}: ${details}.`);
}

function backupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertRunId(runId) {
  if (!runId || path.basename(String(runId)) !== String(runId) || String(runId).includes('\0')) {
    throw backupError('unsafe_backup', 'Backup run identity is invalid.');
  }
}
