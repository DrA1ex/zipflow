import { createHash } from 'node:crypto';
import path from 'node:path';
import { ensureDir, readJson, writeJsonDurableAtomic } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';

const VERSION = 1;
const ACTIONS = new Set(['moved', 'deleted', 'kept', 'missing', 'failed']);

export async function saveClientHistoryMetadata(runId, { archiveDisposition } = {}) {
  const value = {
    version: VERSION,
    runId: normalizeRunId(runId),
    archiveDisposition: normalizeArchiveDisposition(archiveDisposition),
    updatedAt: new Date().toISOString(),
  };
  const target = metadataPath(value.runId);
  await ensureDir(path.dirname(target));
  await writeJsonDurableAtomic(target, value);
  return structuredClone(value);
}

export async function loadClientHistoryMetadata(runId) {
  const normalized = normalizeRunId(runId);
  const value = await readJson(metadataPath(normalized), null);
  if (
    value?.version !== VERSION
    || value.runId !== normalized
    || !value.archiveDisposition
  ) {
    return null;
  }
  return {
    version: VERSION,
    runId: normalized,
    archiveDisposition: normalizeArchiveDisposition(value.archiveDisposition),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  };
}

function metadataPath(runId) {
  const digest = createHash('sha256').update(runId).digest('hex');
  return path.join(getZipflowHome(), 'standalone-client-history', `${digest}.json`);
}

function normalizeRunId(value) {
  const runId = String(value ?? '');
  if (!runId || runId.length > 512 || /[\u0000-\u001f\u007f]/.test(runId)) {
    throw new TypeError('Run ID is invalid.');
  }
  return runId;
}

function normalizeArchiveDisposition(value) {
  const action = ACTIONS.has(value?.action) ? value.action : 'failed';
  return {
    action,
    ...textField('path', value?.path),
    ...textField('originalPath', value?.originalPath),
    ...textField('error', value?.error),
  };
}

function textField(key, value) {
  if (typeof value !== 'string' || !value) return {};
  return { [key]: value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 4096) };
}
