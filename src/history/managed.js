import path from 'node:path';
import { canonicalPath } from '../utils/paths.js';
import { hashText } from '../utils/hash.js';
import { ensureDir, readJson, writeJsonAtomic } from '../utils/fs.js';
import { ensureZipflowHome, getZipflowHome } from '../workflow/store.js';

const HISTORY_VERSION = 1;

export async function loadManagedHistory(projectPath) {
  const target = await managedHistoryPath(projectPath);
  const stored = await readJson(target, null);
  if (!stored) return emptyHistory(await canonicalPath(projectPath));
  return normalizeHistory(stored, await canonicalPath(projectPath));
}

export async function updateManagedHistory(projectPath, appliedItems, { enabled = true } = {}) {
  const before = await loadManagedHistory(projectPath);
  if (!enabled) return { before: before.paths, after: before.paths, recording: false };
  const paths = new Set(before.paths);
  for (const item of appliedItems) {
    if (!item?.path) continue;
    if (item.kind === 'deleted') paths.delete(item.path);
    else if (item.kind === 'created' || item.kind === 'updated') paths.add(item.path);
  }
  const after = await saveManagedHistory(projectPath, { ...before, paths: [...paths].sort() });
  return { before: before.paths, after: after.paths, recording: true };
}

export async function restoreManagedHistory(projectPath, paths) {
  return saveManagedHistory(projectPath, { paths: Array.isArray(paths) ? paths : [] });
}

export async function resetManagedHistory(projectPath) {
  const previous = await loadManagedHistory(projectPath);
  await saveManagedHistory(projectPath, { paths: [] });
  return { removed: previous.paths.length };
}

export async function managedHistoryPath(projectPath) {
  await ensureZipflowHome();
  const canonical = await canonicalPath(projectPath);
  const directory = path.join(getZipflowHome(), 'projects', hashText(canonical).slice(0, 24));
  await ensureDir(directory);
  return path.join(directory, 'managed-files.json');
}

async function saveManagedHistory(projectPath, value) {
  const canonical = await canonicalPath(projectPath);
  const normalized = normalizeHistory(value, canonical);
  await writeJsonAtomic(await managedHistoryPath(projectPath), normalized);
  return normalized;
}

function normalizeHistory(value, projectPath) {
  return {
    version: HISTORY_VERSION,
    projectPath,
    paths: [...new Set(Array.isArray(value?.paths) ? value.paths.filter(Boolean) : [])].sort(),
    updatedAt: new Date().toISOString(),
  };
}

function emptyHistory(projectPath) {
  return { version: HISTORY_VERSION, projectPath, paths: [], updatedAt: null };
}
