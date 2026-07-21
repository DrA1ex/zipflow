import path from 'node:path';
import { copyFile, rename, stat, unlink } from 'node:fs/promises';
import { ensureDir, exists, readJson, writeJsonAtomic } from '../utils/fs.js';
import { expandHome } from '../utils/paths.js';
import { getZipflowHome } from '../workflow/store.js';
import { throwIfCancelled } from '../operations/manager.js';

export async function applySourceArchivePolicy({ archivePath, runId, settings, now = new Date(), signal = null }) {
  throwIfCancelled(signal);
  const policy = settings.archivePolicy ?? 'keep';
  if (policy === 'keep') return { action: 'kept', originalPath: archivePath, path: archivePath, pruned: [] };
  if (!(await exists(archivePath))) return { action: 'missing', originalPath: archivePath, path: null, pruned: [] };
  if (policy === 'delete') {
    throwIfCancelled(signal);
    await unlink(archivePath);
    return { action: 'deleted', originalPath: archivePath, path: null, pruned: [] };
  }
  if (policy !== 'move') throw new Error(`Unknown source archive policy: ${policy}`);
  const directory = path.resolve(expandHome(settings.archiveDirectory || '~/zipflow-archive'));
  await ensureDir(directory);
  const destination = await chooseDestination(directory, path.basename(archivePath), runId, archivePath);
  throwIfCancelled(signal);
  if (path.resolve(destination) !== path.resolve(archivePath)) await moveFile(archivePath, destination);
  const fileStat = await stat(destination);
  const index = await loadArchiveIndex();
  index.records = index.records.filter((record) => path.resolve(record.path) !== path.resolve(destination));
  index.records.push({
    path: destination,
    originalPath: archivePath,
    runId,
    addedAt: now.toISOString(),
    size: fileStat.size,
  });
  const pruned = await pruneManagedArchives(index, {
    now,
    retentionDays: settings.archiveRetentionDays,
    maxBytes: settings.archiveMaxBytes,
    signal,
  });
  await saveArchiveIndex(index);
  return { action: 'moved', originalPath: archivePath, path: destination, pruned };
}

export async function pruneManagedArchives(index, {
  now = new Date(), retentionDays = 30, maxBytes = 1_000_000_000, signal = null,
} = {}) {
  const active = [];
  const pruned = [];
  const deadline = Number(retentionDays) > 0 ? now.getTime() - Number(retentionDays) * 86_400_000 : null;
  for (const record of index.records ?? []) {
    throwIfCancelled(signal);
    if (!(await exists(record.path))) continue;
    if (deadline !== null && new Date(record.addedAt).getTime() < deadline) {
      await removeManagedFile(record, 'retention', pruned);
      continue;
    }
    const actual = await stat(record.path);
    active.push({ ...record, size: actual.size });
  }
  active.sort((left, right) => new Date(left.addedAt) - new Date(right.addedAt));
  if (Number(maxBytes) > 0) {
    let total = active.reduce((sum, record) => sum + record.size, 0);
    while (active.length && total > Number(maxBytes)) {
      throwIfCancelled(signal);
      const record = active.shift();
      await removeManagedFile(record, 'size', pruned);
      total -= record.size;
    }
  }
  index.records = active;
  index.updatedAt = now.toISOString();
  return pruned;
}

export async function inspectManagedArchives({ signal = null } = {}) {
  const index = await loadArchiveIndex();
  const records = [];
  for (const record of index.records ?? []) {
    throwIfCancelled(signal);
    if (!(await exists(record.path))) continue;
    const actual = await stat(record.path);
    records.push({ ...record, size: actual.size });
  }
  records.sort((left, right) => new Date(left.addedAt) - new Date(right.addedAt));
  if (records.length !== (index.records ?? []).length) {
    index.records = records;
    await saveArchiveIndex(index);
  }
  return {
    count: records.length,
    totalBytes: records.reduce((sum, record) => sum + record.size, 0),
    oldestAt: records[0]?.addedAt ?? null,
    records,
  };
}

export async function clearManagedArchives({ signal = null, onProgress = null } = {}) {
  const index = await loadArchiveIndex();
  const records = index.records ?? [];
  const removed = [];
  const failed = [];
  const remaining = [];
  let cancelled = false;
  for (let indexPosition = 0; indexPosition < records.length; indexPosition += 1) {
    const record = records[indexPosition];
    if (signal?.aborted) {
      cancelled = true;
      remaining.push(...records.slice(indexPosition));
      break;
    }
    try {
      if (await exists(record.path)) await unlink(record.path);
      removed.push(record);
      onProgress?.({ removed: removed.length, record });
    } catch (error) {
      failed.push({ record, error: error.message });
      remaining.push(record);
    }
  }
  index.records = remaining;
  index.updatedAt = new Date().toISOString();
  await saveArchiveIndex(index);
  return {
    removed, failed, cancelled,
    totalBytes: removed.reduce((sum, record) => sum + Number(record.size ?? 0), 0),
  };
}

export function archiveIndexPath() {
  return path.join(getZipflowHome(), 'archive-index.json');
}

async function loadArchiveIndex() {
  return readJson(archiveIndexPath(), { version: 1, records: [] });
}

async function saveArchiveIndex(index) {
  await writeJsonAtomic(archiveIndexPath(), {
    version: 1,
    records: index.records ?? [],
    updatedAt: index.updatedAt ?? new Date().toISOString(),
  });
}

async function chooseDestination(directory, filename, runId, sourcePath) {
  const direct = path.join(directory, filename);
  if (path.resolve(direct) === path.resolve(sourcePath) || !(await exists(direct))) return direct;
  const extension = path.extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  let candidate = path.join(directory, `${stem}-${runId}${extension}`);
  let suffix = 2;
  while (await exists(candidate)) candidate = path.join(directory, `${stem}-${runId}-${suffix++}${extension}`);
  return candidate;
}

async function moveFile(source, destination) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyFile(source, destination);
    await unlink(source);
  }
}

async function removeManagedFile(record, reason, pruned) {
  await unlink(record.path);
  pruned.push({ path: record.path, reason, size: record.size, runId: record.runId });
}
