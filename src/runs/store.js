import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic, writeTextAtomic } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';
import { formatRunReport } from './text-report.js';

export async function createRunRecord({ id, project, workflow, archivePath }) {
  const record = {
    version: 4,
    id,
    projectPath: project.root,
    projectName: project.name,
    workflowName: workflow.name,
    archivePath,
    archiveMetadata: null,
    archiveDisposition: null,
    patch: null,
    llm: null,
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

export function runDirectory(runId) {
  return path.join(getZipflowHome(), 'runs', runId);
}

export function runReportPath(runId) {
  return path.join(runDirectory(runId), 'report.txt');
}
