import path from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';
import { ensureDir, readJson, writeJsonAtomic, writeTextAtomic } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';
import { canonicalPath } from '../utils/paths.js';
import { formatRunReport } from './text-report.js';
import { withStorageLease } from '../storage/lease.js';
import { ensureActiveRunLease, listActiveRunIds, releaseActiveRunLease } from '../storage/run-leases.js';

export async function createRunRecord({ id, project, workflow, archivePath, archiveHash = null, archiveInfo = null }) {
  const record = {
    version: 9,
    id,
    projectPath: project.root,
    projectName: project.name,
    workflowName: workflow.name,
    archivePath,
    archiveHash,
    archiveInfo,
    archiveMetadata: null,
    archiveDisposition: null,
    patch: null,
    llm: null,
    llmFailure: null,
    archiveSafety: null,
    status: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plan: null,
    applied: null,
    checks: null,
    checkpoint: null,
    commit: null,
    deploy: null,
    managedHistory: null,
    rollback: null,
    decisions: [],
    autonomy: {
      mode: workflow.autonomy?.mode ?? 'manual', paused: false, decisions: [], fallbackCount: 0, checkRetries: 0, deployRetries: 0,
    },
    error: null,
  };
  await ensureActiveRunLease(record.id);
  await saveRunRecord(record);
  return record;
}


export async function createActionRunRecord({ id, project, workflow, action }) {
  const record = {
    version: 9,
    id,
    kind: action,
    projectPath: project.root,
    projectName: project.name,
    workflowName: workflow.name,
    archivePath: null,
    archiveHash: null,
    archiveInfo: null,
    archiveMetadata: null,
    archiveDisposition: null,
    patch: null,
    llm: null,
    llmFailure: null,
    archiveSafety: null,
    status: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plan: null,
    applied: null,
    checks: null,
    checkpoint: null,
    commit: null,
    deploy: null,
    managedHistory: null,
    rollback: null,
    decisions: [],
    autonomy: { mode: 'manual', paused: false, decisions: [], fallbackCount: 0, checkRetries: 0, deployRetries: 0 },
    error: null,
  };
  await ensureActiveRunLease(record.id);
  await saveRunRecord(record);
  return record;
}

export async function saveRunRecord(record) {
  if (!TERMINAL_RUN_STATUSES.has(record.status)) await ensureActiveRunLease(record.id);
  const value = await withStorageLease('run-history', async () => {
    const root = runDirectory(record.id);
    await ensureDir(root);
    const next = { ...record, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(path.join(root, 'report.json'), next);
    await writeTextAtomic(path.join(root, 'report.txt'), formatRunReport(next));
    return next;
  });
  if (TERMINAL_RUN_STATUSES.has(value.status)) await releaseActiveRunLease(value.id);
  return value;
}

export async function loadRunRecord(runId) {
  return readJson(path.join(runDirectory(runId), 'report.json'), null);
}

export async function listProjectRuns(projectPath, { limit = 30 } = {}) {
  const target = await canonicalPath(projectPath);
  let entries = [];
  try {
    entries = await readdir(path.join(getZipflowHome(), 'runs'), { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = await loadRunRecord(entry.name).catch(() => null);
    if (!record?.projectPath) continue;
    const recordPath = await canonicalPath(record.projectPath).catch(() => path.resolve(record.projectPath));
    if (recordPath === target) records.push(record);
  }
  records.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  return records.slice(0, limit);
}

export async function findAppliedArchiveRun(projectPath, archiveHash) {
  if (!archiveHash) return null;
  const runs = await listProjectRuns(projectPath, { limit: 100 });
  return runs.find((run) => run.archiveHash === archiveHash && [
    'applied', 'checks_passed', 'checks_failed', 'completed', 'completed_with_errors', 'rolled_back', 'no_changes',
  ].includes(run.status)) ?? null;
}

export function runDirectory(runId) {
  return path.join(getZipflowHome(), 'runs', runId);
}

export function runReportPath(runId) {
  return path.join(runDirectory(runId), 'report.txt');
}

export const DEFAULT_RUN_RETENTION_DAYS = 90;
export const DEFAULT_RUN_STORAGE_BYTES = 512 * 1024 * 1024;

const TERMINAL_RUN_STATUSES = new Set([
  'cancelled', 'failed', 'no_changes', 'completed', 'completed_with_errors',
  'interrupted_closed', 'rolled_back',
]);

export async function cleanupRunStorage(options = {}) {
  return withStorageLease('run-history', async () => {
    const temporary = await removeOrphanedTemporaryDirectoriesUnlocked(options);
    const retention = await pruneRunHistoryUnlocked(options);
    return { temporary, retention };
  });
}

export async function removeOrphanedTemporaryDirectories(options = {}) {
  return withStorageLease('run-history', () => removeOrphanedTemporaryDirectoriesUnlocked(options));
}

async function removeOrphanedTemporaryDirectoriesUnlocked({ activeRunIds = [] } = {}) {
  const active = await activeRunIdSet(activeRunIds);
  const tempRoot = path.join(getZipflowHome(), 'tmp');
  let entries = [];
  try {
    entries = await readdir(tempRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || active.has(entry.name)) continue;
    const record = await loadRunRecord(entry.name).catch(() => null);
    if (record && !TERMINAL_RUN_STATUSES.has(record.status)) continue;
    await removeRunPath(path.join(tempRoot, entry.name));
    removed.push(entry.name);
  }
  return removed;
}

export async function pruneRunHistory(options = {}) {
  return withStorageLease('run-history', () => pruneRunHistoryUnlocked(options));
}

async function pruneRunHistoryUnlocked({
  activeRunIds = [],
  retentionDays = DEFAULT_RUN_RETENTION_DAYS,
  maxBytes = DEFAULT_RUN_STORAGE_BYTES,
  now = Date.now(),
} = {}) {
  const runsRoot = path.join(getZipflowHome(), 'runs');
  let entries = [];
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: [], totalBytes: 0 };
    throw error;
  }
  const active = await activeRunIdSet(activeRunIds);
  const candidates = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(runsRoot, entry.name);
    const [record, details] = await Promise.all([
      loadRunRecord(entry.name).catch(() => null),
      runDirectoryDetails(directory),
    ]);
    totalBytes += details.size;
    const protectedRun = active.has(entry.name)
      || Boolean(record?.important || record?.protected || record?.retained)
      || Boolean(record && !TERMINAL_RUN_STATUSES.has(record.status));
    candidates.push({
      id: entry.name,
      directory,
      size: details.size,
      timestamp: parsedTime(record?.createdAt) ?? details.mtimeMs,
      protected: protectedRun,
    });
  }
  candidates.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  const removed = [];
  const ageLimit = Math.max(0, Number(retentionDays)) * 24 * 60 * 60_000;
  for (const candidate of candidates) {
    if (candidate.protected || now - candidate.timestamp <= ageLimit) continue;
    await removeRunPath(candidate.directory);
    totalBytes -= candidate.size;
    removed.push(candidate.id);
    candidate.removed = true;
  }
  const storageLimit = Math.max(0, Number(maxBytes));
  for (const candidate of candidates) {
    if (totalBytes <= storageLimit) break;
    if (candidate.protected || candidate.removed) continue;
    await removeRunPath(candidate.directory);
    totalBytes -= candidate.size;
    removed.push(candidate.id);
    candidate.removed = true;
  }
  return { removed, totalBytes: Math.max(0, totalBytes) };
}

async function runDirectoryDetails(directory) {
  const info = await stat(directory);
  return { size: await directorySize(directory), mtimeMs: info.mtimeMs };
}

async function directorySize(directory) {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else if (entry.isFile()) {
      const info = await stat(target);
      total += info.size;
    }
  }
  return total;
}

async function removeRunPath(target) {
  await rm(target, { recursive: true, force: true });
}

async function activeRunIdSet(values = []) {
  const active = await listActiveRunIds();
  for (const value of values) active.add(value);
  return active;
}

function parsedTime(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
