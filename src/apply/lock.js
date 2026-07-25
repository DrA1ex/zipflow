import path from 'node:path';
import { open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ensureDir, readJson, syncDirectory, writeJsonAtomic } from '../utils/fs.js';
import { hashText } from '../utils/hash.js';
import { getZipflowHome } from '../workflow/store.js';
import { canonicalPath } from '../utils/paths.js';

export const PROJECT_LOCK_HEARTBEAT_MS = 5_000;
export const PROJECT_LOCK_STALE_MS = 30_000;
export const LEGACY_PROJECT_LOCK_STALE_MS = 24 * 60 * 60_000;

export async function acquireProjectLock(projectPath, runId, options = {}) {
  const canonicalProjectPath = await canonicalPath(projectPath);
  const directory = path.join(getZipflowHome(), 'locks');
  await ensureDir(directory);
  const target = path.join(directory, `${hashText(canonicalProjectPath).slice(0, 24)}.lock`);
  const now = options.now ?? (() => Date.now());
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? PROJECT_LOCK_HEARTBEAT_MS;
  const staleAfterMs = options.staleAfterMs ?? PROJECT_LOCK_STALE_MS;
  const legacyStaleAfterMs = options.legacyStaleAfterMs ?? LEGACY_PROJECT_LOCK_STALE_MS;
  const ownerToken = randomUUID();
  const createdAt = new Date(now()).toISOString();
  const value = {
    version: 2,
    pid: process.pid,
    projectPath: canonicalProjectPath,
    runId,
    ownerToken,
    createdAt,
    heartbeatAt: createdAt,
  };

  try {
    await createExclusiveLock(target, value);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readJson(target, {}).catch(() => ({}));
    if (isStaleLock(existing, { now: now(), isAlive, staleAfterMs, legacyStaleAfterMs })) {
      const removed = await removeMatchingLock(target, existing);
      if (removed) return acquireProjectLock(canonicalProjectPath, runId, options);
    }
    throw new Error(`Another Zipflow run is active for this project${existing.runId ? ` (${existing.runId})` : ''}.`);
  }

  let released = false;
  let heartbeatWork = Promise.resolve();
  const heartbeat = async () => {
    if (released) return false;
    const current = await readJson(target, null).catch(() => null);
    if (!sameOwner(current, ownerToken)) return false;
    value.heartbeatAt = new Date(now()).toISOString();
    await writeJsonAtomic(target, value);
    return true;
  };
  const timer = heartbeatIntervalMs > 0
    ? setInterval(() => {
      heartbeatWork = heartbeatWork.then(heartbeat).catch(() => false);
    }, heartbeatIntervalMs)
    : null;
  timer?.unref?.();

  return {
    path: target,
    ownerToken,
    heartbeat,
    async release() {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      await heartbeatWork.catch(() => {});
      const current = await readJson(target, null).catch(() => null);
      if (sameOwner(current, ownerToken)) {
        await rm(target, { force: true });
        await syncDirectory(path.dirname(target));
      }
    },
  };
}

async function createExclusiveLock(target, value) {
  let handle = null;
  try {
    handle = await open(target, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(path.dirname(target));
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeMatchingLock(target, expected) {
  const current = await readJson(target, null).catch(() => null);
  if (!sameLock(current, expected)) return false;
  await rm(target, { force: true });
  await syncDirectory(path.dirname(target));
  return true;
}

function isStaleLock(lock, { now, isAlive, staleAfterMs, legacyStaleAfterMs }) {
  if (!lock || typeof lock !== 'object' || !Number.isInteger(lock.pid)) return true;
  if (!isAlive(lock.pid)) return true;
  const heartbeat = Date.parse(lock.heartbeatAt);
  if (lock.ownerToken) return !Number.isFinite(heartbeat) || now - heartbeat > staleAfterMs;
  const created = Date.parse(lock.createdAt);
  return Number.isFinite(created) && now - created > legacyStaleAfterMs;
}

function sameOwner(lock, ownerToken) {
  return Boolean(lock && lock.ownerToken === ownerToken);
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
