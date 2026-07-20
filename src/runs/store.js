import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { ensureDir, readJson, writeJsonAtomic, writeTextAtomic } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';
import { canonicalPath } from '../utils/paths.js';
import { formatRunReport } from './text-report.js';

export async function createRunRecord({ id, project, workflow, archivePath, archiveHash = null, archiveInfo = null }) {
  const record = {
    version: 7,
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
    error: null,
  };
  await saveRunRecord(record);
  return record;
}

export async function saveRunRecord(record) {
  const root = runDirectory(record.id);
  await ensureDir(root);
  const value = { ...record, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(path.join(root, 'report.json'), value);
  await writeTextAtomic(path.join(root, 'report.txt'), formatRunReport(value));
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
    'applied', 'checks_passed', 'checks_failed', 'completed', 'completed_with_errors', 'rolled_back',
  ].includes(run.status)) ?? null;
}

export function runDirectory(runId) {
  return path.join(getZipflowHome(), 'runs', runId);
}

export function runReportPath(runId) {
  return path.join(runDirectory(runId), 'report.txt');
}
