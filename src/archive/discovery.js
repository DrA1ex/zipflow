import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import yauzl from 'yauzl';
import { DEFAULT_ARCHIVE_LIMITS, validateZipEntry } from './security.js';
import { listTrackedFiles } from '../git/repository.js';
import { walkFiles } from '../utils/fs.js';
import { scoreArchiveMatch } from './discovery-match.js';

export const RECENT_ARCHIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export async function discoverRecentArchives({
  directory, project, now = Date.now(), maxAgeMs = RECENT_ARCHIVE_MAX_AGE_MS, signal = null, limit = 20,
} = {}) {
  if (!directory) return [];
  const projectPaths = await collectProjectPaths(project, { signal });
  const entries = await readdir(directory, { withFileTypes: true });
  const inspected = [];
  for (const entry of entries) {
    throwIfCancelled(signal);
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) continue;
    const archivePath = path.join(directory, entry.name);
    try {
      const info = await inspectDiscoveredArchive(archivePath);
      const modifiedAt = info.modifiedAt;
      const ageMs = Math.max(0, now - modifiedAt.getTime());
      if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) continue;
      inspected.push({ archivePath, info, modifiedAt, ageMs });
    } catch {
      // Unsafe paths and files that disappear during the scan are not candidates.
    }
  }
  inspected.sort((a, b) => a.ageMs - b.ageMs);
  const candidates = [];
  for (const item of inspected.slice(0, Math.max(limit * 2, limit))) {
    throwIfCancelled(signal);
    try {
      const archivePaths = await listArchivePaths(item.archivePath, { signal });
      const match = scoreArchiveMatch(projectPaths, archivePaths);
      if (!match.suitable) continue;
      candidates.push({
        path: item.archivePath,
        name: path.basename(item.archivePath),
        modifiedAt: item.modifiedAt.toISOString(),
        ageMs: item.ageMs,
        size: item.info.size,
        fileCount: archivePaths.length,
        ...match,
      });
    } catch {
      // A malformed or unsafe ZIP is ignored here and remains rejected by normal inspection if entered manually.
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.ageMs - b.ageMs).slice(0, limit);
}


async function inspectDiscoveredArchive(archivePath) {
  const info = await lstat(archivePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Archive candidate is not a regular file.');
  return { size: info.size, modifiedAt: info.mtime };
}

export async function listArchivePaths(archivePath, { signal = null, limits = DEFAULT_ARCHIVE_LIMITS } = {}) {
  const zip = await openZip(archivePath);
  const paths = [];
  const seen = new Set();
  let entries = 0;
  let totalSize = 0;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on('entry', (entry) => {
        try {
          throwIfCancelled(signal);
          const validated = validateZipEntry(entry, limits);
          entries += 1;
          if (entries > limits.maxFiles) throw new Error('Archive contains too many entries.');
          totalSize += entry.uncompressedSize;
          if (totalSize > limits.maxTotalSize) throw new Error('Archive expands beyond the configured size limit.');
          if (!validated.skip && !validated.directory) {
            if (seen.has(validated.collisionKey)) throw new Error(`Archive contains duplicate paths: ${validated.path}`);
            seen.add(validated.collisionKey);
            paths.push(validated.path);
          }
          zip.readEntry();
        } catch (error) {
          fail(error);
        }
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return paths;
}

async function collectProjectPaths(project, { signal = null } = {}) {
  if (!project?.root) return [];
  if (project.git) {
    try {
      const tracked = await listTrackedFiles(project.root);
      if (tracked.length) return tracked;
    } catch {
      // Fall through to a filesystem scan when Git is unavailable or temporarily locked.
    }
  }
  return walkFiles(project.root, {
    signal,
    descend: (relative) => !ignoredDirectory(relative),
    include: (relative) => !relative.toLowerCase().endsWith('.zip'),
  });
}

function ignoredDirectory(relative) {
  return String(relative).split('/').some((segment) => [
    '.git', '.zipflow', 'node_modules', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__',
  ].includes(segment));
}

function openZip(target) {
  return new Promise((resolve, reject) => {
    yauzl.open(target, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function throwIfCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Operation cancelled.');
  error.code = 'cancelled';
  throw error;
}
