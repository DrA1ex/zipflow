import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { exists, walkFiles } from '../utils/fs.js';
import { listIgnoredPaths, listTrackedFiles } from '../git/repository.js';
import { createRootGitignoreMatcher } from '../git/ignore.js';
import { isProtectedProjectPath } from '../archive/protected.js';
import { normalizeRelativePath } from '../plan/matcher.js';
import { assertSafeProjectPath } from '../security/project-path.js';

export async function listExportTopLevel(projectRoot) {
  const entries = await readdir(projectRoot, { withFileTypes: true });
  return entries
    .filter((entry) => (entry.isDirectory() || entry.isFile()) && !isProtectedProjectPath(entry.name))
    .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }))
    .sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1);
}

export async function collectExportPaths({ project, mode, selectedRoots = [], onProgress = null, signal = null }) {
  if (mode === 'tracked') {
    if (!project.git) throw new Error('Tracked-only export requires a Git repository.');
    onProgress?.({ phase: 'tracked', current: 0, detail: 'Reading Git-tracked paths' });
    return filterExistingFiles(project.root, await listTrackedFiles(project.root), { onProgress, signal });
  }
  const all = await walkFiles(project.root, {
    include: (relative) => !isProtectedProjectPath(relative),
    descend: (relative) => !isProtectedProjectPath(relative),
    signal,
    onVisit: ({ relative, files }) => onProgress?.({ phase: 'scan', current: files, detail: relative }),
  });
  if (mode === 'all') return all;
  if (mode === 'interactive') {
    const selected = new Set(selectedRoots);
    return all.filter((relative) => selected.has(normalizeRelativePath(relative).split('/')[0]));
  }
  if (mode === 'nonignored') {
    if (project.git) {
      const ignored = await listIgnoredPaths(project.root, all, { includeTracked: true });
      return all.filter((relative) => !ignored.has(relative));
    }
    const ignored = await createRootGitignoreMatcher(project.root);
    return all.filter((relative) => !ignored(relative));
  }
  throw new Error(`Unknown ZIP export mode: ${mode}`);
}

async function filterExistingFiles(root, paths, { onProgress = null, signal = null } = {}) {
  const result = [];
  for (let index = 0; index < paths.length; index += 1) {
    if (signal?.aborted) throw Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' });
    const relative = paths[index];
    onProgress?.({ phase: 'tracked', current: index + 1, total: paths.length, detail: relative });
    const normalized = normalizeRelativePath(relative);
    if (isProtectedProjectPath(normalized)) continue;
    if (!(await exists(path.join(root, normalized)))) continue;
    await assertSafeProjectPath(root, normalized, { allowMissingLeaf: false, requireFile: true });
    result.push(normalized);
  }
  return result.sort();
}

export async function collectCustomExportPaths({ project, onProgress = null, signal = null }) {
  return walkFiles(project.root, {
    include: (relative) => !isRuntimeInternalPath(relative),
    descend: (relative) => !isRuntimeInternalDirectory(relative),
    signal,
    onVisit: ({ relative, files }) => onProgress?.({ phase: 'scan', current: files, detail: relative }),
  });
}

export async function classifyCustomExportPaths(project, paths) {
  let ignored = new Set();
  if (project.git) ignored = await listIgnoredPaths(project.root, paths, { includeTracked: true });
  else {
    const matcher = await createRootGitignoreMatcher(project.root);
    ignored = new Set(paths.filter((relative) => matcher(relative)));
  }
  const annotations = new Map();
  for (const relative of paths) {
    const root = normalizeRelativePath(relative).split('/')[0].toLowerCase();
    if (root === '.git') annotations.set(relative, { kind: 'protected', reason: 'Git repository metadata', excludedByDefault: true });
    else if (root === '.zipflow') annotations.set(relative, { kind: 'protected', reason: 'Zipflow internal data', excludedByDefault: true });
    else if (ignored.has(relative)) annotations.set(relative, { kind: 'ignored', reason: 'Ignored by project rules', excludedByDefault: true });
  }
  return annotations;
}

function isRuntimeInternalPath(relative) {
  const normalized = normalizeRelativePath(relative).toLowerCase();
  if (normalized.startsWith('.zipflow/tmp/')) return true;
  if (normalized === '.git/index.lock' || normalized.endsWith('/.git/index.lock')) return true;
  if (normalized.startsWith('.git/') && normalized.endsWith('.lock')) return true;
  if (normalized.startsWith('.zipflow/') && normalized.endsWith('.lock')) return true;
  return false;
}

function isRuntimeInternalDirectory(relative) {
  const normalized = normalizeRelativePath(relative).toLowerCase().replace(/\/$/, '');
  return normalized === '.zipflow/tmp';
}
