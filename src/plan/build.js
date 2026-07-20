import path from 'node:path';
import { stat } from 'node:fs/promises';
import { exists, walkFiles } from '../utils/fs.js';
import { hashFile } from '../utils/hash.js';
import { getGitStatus, listIgnoredPaths, listTrackedFiles } from '../git/repository.js';
import { createRootGitignoreMatcher } from '../git/ignore.js';
import { loadManagedHistory } from '../history/managed.js';
import { isArchiveControlPath } from '../archive/metadata.js';
import { isProtectedProjectPath } from '../archive/protected.js';
import { createPathMatcher, normalizeRelativePath } from './matcher.js';
import { deletionProtectionReason, isDeletionProtectedProjectPath } from './deletion-protection.js';

export async function buildUpdatePlan({ project, workflow, extracted }) {
  const excluded = createPathMatcher(workflow.exclude);
  const normalizedEntries = extracted.entries
    .map((entry) => ({ ...entry, relativePath: normalizeRelativePath(entry.relativePath) }))
    .filter((entry) => entry.relativePath && !isArchiveControlPath(entry.relativePath));
  const skipped = [];
  const candidates = [];
  for (const entry of normalizedEntries) {
    const reason = incomingSkipReason(entry.relativePath, excluded);
    if (reason) skipped.push({ path: entry.relativePath, reason });
    else candidates.push(entry);
  }
  const ignoredIncoming = await ignoredPaths(project, candidates.map((entry) => entry.relativePath));
  const archiveEntries = [];
  for (const entry of candidates) {
    if (ignoredIncoming.has(entry.relativePath)) skipped.push({ path: entry.relativePath, reason: 'ignored by .gitignore' });
    else archiveEntries.push(entry);
  }
  const created = [];
  const updated = [];
  const unchanged = [];
  for (const entry of archiveEntries) {
    const currentPath = path.join(project.root, entry.relativePath);
    const afterHash = await hashFile(entry.absolutePath);
    if (!(await exists(currentPath))) {
      created.push(planItem('created', entry, currentPath, null, afterHash));
      continue;
    }
    const currentStat = await stat(currentPath);
    if (!currentStat.isFile()) throw new Error(`Archive file collides with a non-file path: ${entry.relativePath}`);
    const beforeHash = await hashFile(currentPath);
    if (beforeHash === afterHash) unchanged.push({ path: entry.relativePath, hash: beforeHash });
    else updated.push(planItem('updated', entry, currentPath, beforeHash, afterHash));
  }
  const incomingSet = new Set([...created, ...updated, ...unchanged].map((item) => item.path));
  const snapshot = workflow.archive.mode === 'snapshot'
    ? await findSnapshotChanges({ project, workflow, excluded, incomingSet })
    : { deleted: [], preserved: [] };
  const gitStatus = project.git ? await getGitStatus(project.root) : null;
  const conflicts = identifyConflicts([...updated, ...snapshot.deleted], gitStatus);
  skipped.sort((left, right) => left.path.localeCompare(right.path));
  return {
    created,
    updated,
    deleted: snapshot.deleted,
    preserved: snapshot.preserved,
    unchanged,
    skipped,
    conflicts,
    ignoredIncoming: [...ignoredIncoming].sort(),
    gitStatus,
    counts: {
      created: created.length,
      updated: updated.length,
      deleted: snapshot.deleted.length,
      preserved: snapshot.preserved.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
      conflicts: conflicts.length,
    },
  };
}

async function findSnapshotChanges({ project, workflow, excluded, incomingSet }) {
  const allManaged = await walkManagedFiles(project.root, excluded);
  const ignored = await ignoredPaths(project, allManaged);
  const protectedMissing = deletionProtectedPreserved(allManaged, incomingSet);
  const eligible = allManaged.filter((relative) => !ignored.has(relative) && !isDeletionProtectedProjectPath(relative));
  if (workflow.deletion.scope === 'all') {
    const deleted = await collectDeleted(project.root, eligible, incomingSet, excluded);
    const policyPreserved = allManaged
      .filter((relative) => ignored.has(relative) && !incomingSet.has(relative))
      .map((relative) => ({ path: relative, reason: 'ignored local file kept by .gitignore policy' }));
    return { deleted, preserved: mergePreserved(protectedMissing, policyPreserved) };
  }
  if (workflow.deletion.scope === 'managed-history') {
    const history = await loadManagedHistory(project.root);
    const managed = new Set(history.paths.map(normalizeRelativePath));
    const deleted = await collectDeleted(
      project.root,
      eligible.filter((relative) => managed.has(relative)),
      incomingSet,
      excluded,
    );
    const policyPreserved = allManaged
      .filter((relative) => !incomingSet.has(relative) && (ignored.has(relative) || !managed.has(relative)))
      .sort((left, right) => left.localeCompare(right))
      .map((relative) => ({
        path: relative,
        reason: ignored.has(relative)
          ? 'ignored local file kept by .gitignore policy'
          : 'local file kept because Zipflow has not previously created or updated it',
      }));
    return { deleted, preserved: mergePreserved(protectedMissing, policyPreserved) };
  }
  if (!project.git) {
    const policyPreserved = eligible
      .filter((relative) => !incomingSet.has(relative))
      .map((relative) => ({ path: relative, reason: 'local file kept because tracked-only snapshot requires Git' }));
    return { deleted: [], preserved: mergePreserved(protectedMissing, policyPreserved) };
  }
  const tracked = new Set((await listTrackedFiles(project.root)).map(normalizeRelativePath));
  const deleted = await collectDeleted(
    project.root,
    eligible.filter((relative) => tracked.has(relative)),
    incomingSet,
    excluded,
  );
  const policyPreserved = allManaged
    .filter((relative) => !incomingSet.has(relative) && (!tracked.has(relative) || ignored.has(relative)))
    .sort((left, right) => left.localeCompare(right))
    .map((relative) => ({
      path: relative,
      reason: ignored.has(relative)
        ? 'ignored local file kept by .gitignore policy'
        : 'untracked local file kept by tracked-only snapshot policy',
    }));
  return { deleted, preserved: mergePreserved(protectedMissing, policyPreserved) };
}

function deletionProtectedPreserved(paths, incomingSet) {
  return paths.flatMap((relative) => {
    if (incomingSet.has(relative)) return [];
    const reason = deletionProtectionReason(relative);
    return reason ? [{ path: relative, reason }] : [];
  });
}

function mergePreserved(...groups) {
  const byPath = new Map();
  for (const item of groups.flat()) {
    if (!byPath.has(item.path)) byPath.set(item.path, item);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function ignoredPaths(project, paths) {
  if (!paths.length) return new Set();
  if (project.git) return listIgnoredPaths(project.root, paths, { includeTracked: true });
  const matcher = await createRootGitignoreMatcher(project.root);
  return new Set(paths.filter((relative) => matcher(relative)));
}

async function walkManagedFiles(root, excluded) {
  return walkFiles(root, {
    include: (relative) => !excluded(relative) && !isProtectedProjectPath(relative),
    descend: (relative) => !excluded(relative) && !isProtectedProjectPath(relative),
  });
}

async function collectDeleted(root, candidates, incomingSet, excluded) {
  const deleted = [];
  for (const relative of candidates) {
    const normalized = normalizeRelativePath(relative);
    if (excluded(normalized) || isProtectedProjectPath(normalized) || isDeletionProtectedProjectPath(normalized) || incomingSet.has(normalized)) continue;
    const currentPath = path.join(root, normalized);
    if (!(await exists(currentPath))) continue;
    const currentStat = await stat(currentPath);
    if (!currentStat.isFile()) continue;
    deleted.push({
      kind: 'deleted',
      path: normalized,
      currentPath,
      beforeHash: await hashFile(currentPath),
      afterHash: null,
      mode: currentStat.mode & 0o777,
    });
  }
  deleted.sort((left, right) => left.path.localeCompare(right.path));
  return deleted;
}

function identifyConflicts(items, gitStatus) {
  if (!gitStatus) return items.map((item) => ({ ...item, reason: 'Project is not a Git repository.' }));
  return items.flatMap((item) => {
    const status = gitStatus.byPath.get(item.path);
    if (!status) return [];
    return [{ ...item, gitStatus: status.status, reason: conflictReason(item, status) }];
  });
}

function incomingSkipReason(relativePath, excluded) {
  if (isProtectedProjectPath(relativePath)) return 'protected Zipflow or Git path';
  if (excluded(relativePath)) return 'excluded by workflow';
  return null;
}

function conflictReason(item, status) {
  if (item.kind === 'deleted') return `Local Git status ${status.status.trim() || status.status}; the file would be deleted.`;
  return `Local Git status ${status.status.trim() || status.status}; archive content is different.`;
}

function planItem(kind, entry, currentPath, beforeHash, afterHash) {
  return {
    kind,
    path: entry.relativePath,
    sourcePath: entry.absolutePath,
    currentPath,
    beforeHash,
    afterHash,
    mode: entry.mode,
  };
}
