import path from 'node:path';
import { open, rm } from 'node:fs/promises';
import { ensureDir, readJson } from '../utils/fs.js';
import { hashText } from '../utils/hash.js';
import { getZipflowHome } from '../workflow/store.js';
import { canonicalPath } from '../utils/paths.js';

export async function acquireProjectLock(projectPath, runId) {
  const canonicalProjectPath = await canonicalPath(projectPath);
  const directory = path.join(getZipflowHome(), 'locks');
  await ensureDir(directory);
  const target = path.join(directory, `${hashText(canonicalProjectPath).slice(0, 24)}.lock`);
  try {
    const handle = await open(target, 'wx');
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, projectPath: canonicalProjectPath, runId, createdAt: new Date().toISOString() }, null, 2)}\n`);
    await handle.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readJson(target, {});
    if (existing.pid && !isProcessAlive(existing.pid)) {
      await rm(target, { force: true });
      return acquireProjectLock(canonicalProjectPath, runId);
    }
    throw new Error(`Another Zipflow run is active for this project${existing.runId ? ` (${existing.runId})` : ''}.`);
  }
  return {
    path: target,
    async release() { await rm(target, { force: true }); },
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
