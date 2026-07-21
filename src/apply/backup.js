import path from 'node:path';
import { stat } from 'node:fs/promises';
import { ensureDir, exists, writeJsonAtomic } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';
import { canonicalPath } from '../utils/paths.js';
import { assertSafeProjectPath } from '../security/project-path.js';
import { throwIfCancelled } from '../operations/manager.js';
import { copyRegularFileNoFollow } from '../security/safe-file.js';

export async function createBackup({ runId, projectPath, items, signal = null }) {
  const root = path.join(getZipflowHome(), 'backups', runId);
  const filesRoot = path.join(root, 'files');
  await ensureDir(filesRoot);
  const manifestItems = [];
  for (const item of items) {
    throwIfCancelled(signal);
    const { target: currentPath, relative } = await assertSafeProjectPath(projectPath, item.path);
    const existed = await exists(currentPath);
    const { target: backupPath } = await assertSafeProjectPath(filesRoot, relative);
    let mode = null;
    if (existed) {
      await ensureDir(path.dirname(backupPath));
      await copyRegularFileNoFollow(currentPath, backupPath, { mode: 0o600, signal, sourceLabel: 'Project backup source' });
      mode = (await stat(currentPath)).mode & 0o777;
    }
    manifestItems.push({
      path: relative,
      kind: item.kind,
      existed,
      beforeHash: item.beforeHash,
      afterHash: item.afterHash,
      mode,
    });
  }
  const canonicalProjectPath = await canonicalPath(projectPath);
  const binding = {
    version: 1,
    runId,
    projectPath: canonicalProjectPath,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(root, 'binding.json'), binding);
  const manifest = {
    version: 1,
    runId,
    projectPath: canonicalProjectPath,
    createdAt: new Date().toISOString(),
    filesRoot,
    items: manifestItems,
  };
  await writeJsonAtomic(path.join(root, 'manifest.json'), manifest);
  return { root, manifest };
}
