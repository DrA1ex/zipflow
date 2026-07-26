import path from 'node:path';
import { acquireStorageLease, listLeaseRecords } from './lease.js';
import { getZipflowHome } from '../workflow/store.js';
import { hashText } from '../utils/hash.js';

const activeLeases = new Map();

export async function ensureActiveRunLease(runId, options = {}) {
  if (!runId) return null;
  const target = runLeasePath(runId);
  if (activeLeases.has(target)) return activeLeases.get(target);
  const lease = await acquireStorageLease(`active-run:${runId}`, {
    ...options,
    path: target,
    waitMs: options.waitMs ?? 0,
  });
  activeLeases.set(target, lease);
  return lease;
}

export async function releaseActiveRunLease(runId) {
  const target = runLeasePath(runId);
  const lease = activeLeases.get(target);
  if (!lease) return;
  activeLeases.delete(target);
  await lease.release();
}

export async function listActiveRunIds(options = {}) {
  const records = await listLeaseRecords(path.join(getZipflowHome(), 'leases', 'runs'), options);
  return new Set(records.map((record) => String(record.name ?? '').replace(/^active-run:/, '')).filter(Boolean));
}

export function runLeasePath(runId) {
  const value = String(runId);
  return path.join(getZipflowHome(), 'leases', 'runs', `${safeRunId(value).slice(0, 48)}-${hashText(value).slice(0, 16)}.lease`);
}

function safeRunId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}
