import path from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';
import { exists, readJson } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';

export function backupDirectory() {
  return path.join(getZipflowHome(), 'backups');
}

export async function inspectBackupStorage() {
  const root = backupDirectory();
  const entries = await safeDirectories(root);
  const records = [];
  for (const entry of entries) {
    const directory = path.join(root, entry.name);
    const manifest = await readJson(path.join(directory, 'manifest.json'), null);
    if (!manifest?.runId) continue;
    const info = await stat(directory).catch(() => null);
    records.push({
      runId: manifest.runId,
      path: directory,
      createdAt: manifest.createdAt ?? info?.birthtime?.toISOString() ?? info?.mtime?.toISOString() ?? null,
      size: await directorySize(directory),
      files: Array.isArray(manifest.items) ? manifest.items.length : 0,
    });
  }
  records.sort((left, right) => dateValue(left.createdAt) - dateValue(right.createdAt));
  return {
    directory: root,
    count: records.length,
    fileCount: records.reduce((sum, record) => sum + record.files, 0),
    totalBytes: records.reduce((sum, record) => sum + record.size, 0),
    oldestAt: records[0]?.createdAt ?? null,
    records,
  };
}

export async function clearBackupStorage({ excludeRunId = null } = {}) {
  const storage = await inspectBackupStorage();
  const removed = [];
  const failed = [];
  for (const record of storage.records) {
    if (excludeRunId && record.runId === excludeRunId) continue;
    try {
      await rm(record.path, { recursive: true, force: true });
      removed.push(record);
    } catch (error) {
      failed.push({ record, error: error.message });
    }
  }
  return {
    removed, failed,
    totalBytes: removed.reduce((sum, record) => sum + record.size, 0),
  };
}

export async function pruneBackupStorage(settings, { activeRunId = null, now = new Date() } = {}) {
  if ((settings.backupRetentionPolicy ?? 'limits') === 'all') return { removed: [], failed: [], totalBytes: 0 };
  const storage = await inspectBackupStorage();
  const removable = storage.records.filter((record) => record.runId !== activeRunId);
  const remove = new Map();
  const retentionDays = Number(settings.backupRetentionDays ?? 30);
  const deadline = retentionDays > 0 ? now.getTime() - retentionDays * 86_400_000 : null;
  if (deadline !== null) {
    for (const record of removable) {
      if (dateValue(record.createdAt) < deadline) remove.set(record.runId, record);
    }
  }
  const maximum = Number(settings.backupMaxBytes ?? 0);
  if (maximum > 0) {
    let remaining = storage.totalBytes - [...remove.values()].reduce((sum, record) => sum + record.size, 0);
    for (const record of removable) {
      if (remaining <= maximum) break;
      if (remove.has(record.runId)) continue;
      remove.set(record.runId, record);
      remaining -= record.size;
    }
  }
  return removeBackups([...remove.values()]);
}

export async function backupExists(runId) {
  return exists(path.join(backupDirectory(), runId, 'manifest.json'));
}

async function removeBackups(records) {
  const removed = [];
  const failed = [];
  for (const record of records) {
    try {
      await rm(record.path, { recursive: true, force: true });
      removed.push(record);
    } catch (error) {
      failed.push({ record, error: error.message });
    }
  }
  return { removed, failed, totalBytes: removed.reduce((sum, record) => sum + record.size, 0) };
}

async function directorySize(root) {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) total += Number((await stat(target).catch(() => null))?.size ?? 0);
    }
  }
  return total;
}

async function safeDirectories(root) {
  return (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory());
}

function dateValue(value) {
  const result = new Date(value ?? 0).getTime();
  return Number.isFinite(result) ? result : 0;
}
