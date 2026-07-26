import path from 'node:path';
import { open, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ensureDir } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';
import { hashText } from '../utils/hash.js';

export const STORAGE_LEASE_HEARTBEAT_MS = 0;
export const STORAGE_LEASE_STALE_MS = 24 * 60 * 60_000;
export const STORAGE_LEASE_WAIT_MS = 15_000;

export async function acquireStorageLease(name, options = {}) {
  const target = options.path ?? storageLeasePath(name);
  const now = options.now ?? (() => Date.now());
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const staleAfterMs = options.staleAfterMs ?? STORAGE_LEASE_STALE_MS;
  const waitMs = options.waitMs ?? STORAGE_LEASE_WAIT_MS;
  const pollMs = options.pollMs ?? 50;
  const ownerToken = randomUUID();
  const deadline = Date.now() + Math.max(0, waitMs);
  await ensureDir(path.dirname(target));

  while (true) {
    const value = {
      version: 2,
      name,
      pid: process.pid,
      ownerToken,
      createdAt: new Date(now()).toISOString(),
    };
    try {
      await createExclusive(target, value);
      return activeLease(target, value);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await readLeaseSnapshot(target);
      if (isStaleLease(current.value, { now: now(), isAlive, staleAfterMs })) {
        if (await removeMatchingLease(target, current)) continue;
      }
      if (Date.now() >= deadline) {
        const busy = new Error(`Shared Zipflow storage is busy: ${name}.`);
        busy.code = 'storage_busy';
        busy.lease = current.value;
        throw busy;
      }
      await delay(pollMs);
    }
  }
}

export async function withStorageLease(name, callback, options = {}) {
  const lease = await acquireStorageLease(name, options);
  try {
    return await callback(lease);
  } finally {
    await lease.release();
  }
}

export async function listLeaseRecords(directory, options = {}) {
  const now = options.now ?? (() => Date.now());
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const staleAfterMs = options.staleAfterMs ?? STORAGE_LEASE_STALE_MS;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.lease')) continue;
    const target = path.join(directory, entry.name);
    const snapshot = await readLeaseSnapshot(target);
    if (isStaleLease(snapshot.value, { now: now(), isAlive, staleAfterMs })) {
      await removeMatchingLease(target, snapshot).catch(() => false);
      continue;
    }
    records.push({ ...snapshot.value, path: target });
  }
  return records;
}

export function storageLeasePath(name) {
  return path.join(getZipflowHome(), 'leases', 'storage', `${hashText(String(name)).slice(0, 24)}.lease`);
}

function activeLease(target, value) {
  let released = false;
  return {
    path: target,
    ownerToken: value.ownerToken,
    heartbeat: async () => !released,
    async release() {
      if (released) return;
      released = true;
      await removeMatchingLease(target, { value, raw: `${JSON.stringify(value, null, 2)}\n` });
    },
  };
}

async function createExclusive(target, value) {
  let handle = null;
  try {
    handle = await open(target, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeMatchingLease(target, expected) {
  const current = await readLeaseSnapshot(target);
  const same = expected?.value && current.value
    ? sameLease(current.value, expected.value)
    : expected?.raw != null && current.raw === expected.raw;
  if (!same) return false;
  await rm(target, { force: true });
  return true;
}

async function readLeaseSnapshot(target) {
  try {
    const raw = await readFile(target, 'utf8');
    try { return { raw, value: JSON.parse(raw) }; } catch { return { raw, value: null }; }
  } catch (error) {
    if (error?.code === 'ENOENT') return { raw: null, value: null };
    throw error;
  }
}

function sameLease(left, right) {
  if (!left || !right) return false;
  if (left.ownerToken || right.ownerToken) return left.ownerToken === right.ownerToken;
  return left.pid === right.pid && left.name === right.name && left.createdAt === right.createdAt;
}

function isStaleLease(value, { now, isAlive, staleAfterMs }) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.pid) || !value.ownerToken) return true;
  if (!isAlive(value.pid)) return true;
  const created = Date.parse(value.createdAt);
  return !Number.isFinite(created) || now - created > staleAfterMs;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
