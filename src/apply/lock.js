import path from 'node:path';
import { open, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ensureDir, readJson } from '../utils/fs.js';
import { hashText } from '../utils/hash.js';
import { getZipflowHome } from '../workflow/store.js';
import { canonicalPath } from '../utils/paths.js';

export const PROJECT_LOCK_STALE_MS = 24 * 60 * 60_000;
export const LEGACY_PROJECT_LOCK_STALE_MS = PROJECT_LOCK_STALE_MS;

export async function acquireProjectLock(projectPath, runId, options = {}) {
  const canonicalProjectPath = await canonicalPath(projectPath);
  const directory = path.join(getZipflowHome(), 'locks');
  await ensureDir(directory);
  const target = path.join(directory, `${hashText(canonicalProjectPath).slice(0, 24)}.lock`);
  const now = options.now ?? (() => Date.now());
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const staleAfterMs = options.staleAfterMs ?? PROJECT_LOCK_STALE_MS;
  const ownerToken = randomUUID();
  const value = {
    version: 3,
    pid: process.pid,
    projectPath: canonicalProjectPath,
    runId,
    ownerToken,
    createdAt: new Date(now()).toISOString(),
  };

  try {
    await createExclusiveLock(target, value);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readLockSnapshot(target);
    if (isStaleLock(existing.value, { now: now(), isAlive, staleAfterMs })) {
      const removed = await removeMatchingLock(target, existing);
      if (removed) return acquireProjectLock(canonicalProjectPath, runId, options);
    }
    const busy = new Error(`Another Zipflow run is active for this project${existing.value?.runId ? ` (${existing.value.runId})` : ''}.`);
    busy.code = 'project_locked';
    busy.lock = existing.value;
    throw busy;
  }

  let released = false;
  return {
    path: target,
    ownerToken,
    heartbeat: async () => !released,
    async release() {
      if (released) return;
      released = true;
      const current = await readJson(target, null).catch(() => null);
      if (current?.ownerToken === ownerToken) await rm(target, { force: true });
    },
  };
}

async function createExclusiveLock(target, value) {
  let handle = null;
  try {
    handle = await open(target, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeMatchingLock(target, expected) {
  const current = await readLockSnapshot(target);
  const same = expected?.value && current.value
    ? sameLock(current.value, expected.value)
    : expected?.raw != null && current.raw === expected.raw;
  if (!same) return false;
  await rm(target, { force: true });
  return true;
}

async function readLockSnapshot(target) {
  try {
    const raw = await readFile(target, 'utf8');
    try { return { raw, value: JSON.parse(raw) }; } catch { return { raw, value: null }; }
  } catch (error) {
    if (error?.code === 'ENOENT') return { raw: null, value: null };
    throw error;
  }
}

function isStaleLock(lock, { now, isAlive, staleAfterMs }) {
  if (!lock || typeof lock !== 'object' || !Number.isInteger(lock.pid)) return true;
  if (!isAlive(lock.pid)) return true;
  const created = Date.parse(lock.createdAt);
  return !Number.isFinite(created) || now - created > staleAfterMs;
}

function sameLock(left, right) {
  if (!left || !right) return false;
  if (left.ownerToken || right.ownerToken) return left.ownerToken === right.ownerToken;
  return left.pid === right.pid && left.runId === right.runId && left.createdAt === right.createdAt;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
