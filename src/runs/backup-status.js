import { loadRunRecord, saveRunRecord } from './store.js';

export async function markBackupsRemoved(records, { reason = 'retention' } = {}) {
  const updated = [];
  for (const record of records ?? []) {
    const run = await loadRunRecord(record.runId).catch(() => null);
    if (!run?.applied) continue;
    run.applied.backupAvailable = false;
    run.applied.backupRemovedAt = new Date().toISOString();
    run.applied.backupRemovalReason = reason;
    updated.push(await saveRunRecord(run));
  }
  return updated;
}
