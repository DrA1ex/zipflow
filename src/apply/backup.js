import path from 'node:path';
import { copyFile, stat } from 'node:fs/promises';
import { ensureDir, exists, writeJsonAtomic } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';

export async function createBackup({ runId, projectPath, items }) {
  const root = path.join(getZipflowHome(), 'backups', runId);
  const filesRoot = path.join(root, 'files');
  await ensureDir(filesRoot);
  const manifestItems = [];
  for (const item of items) {
    const existed = await exists(item.currentPath);
    const backupPath = path.join(filesRoot, item.path);
    let mode = null;
    if (existed) {
      await ensureDir(path.dirname(backupPath));
      await copyFile(item.currentPath, backupPath);
      mode = (await stat(item.currentPath)).mode & 0o777;
    }
    manifestItems.push({
      path: item.path,
      kind: item.kind,
      existed,
      beforeHash: item.beforeHash,
      afterHash: item.afterHash,
      mode,
    });
  }
  const manifest = {
    version: 1,
    runId,
    projectPath,
    createdAt: new Date().toISOString(),
    filesRoot,
    items: manifestItems,
  };
  await writeJsonAtomic(path.join(root, 'manifest.json'), manifest);
  return { root, manifest };
}
