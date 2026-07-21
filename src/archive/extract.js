import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { ensureDir } from '../utils/fs.js';
import { DEFAULT_ARCHIVE_LIMITS, validateZipEntry } from './security.js';

export async function extractArchive(archivePath, destination, { limits = DEFAULT_ARCHIVE_LIMITS, signal = null } = {}) {
  await rm(destination, { recursive: true, force: true });
  await ensureDir(destination);
  const zip = await openZip(archivePath);
  const entries = [];
  const seenPaths = new Map();
  let processedEntries = 0;
  let totalSize = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', async (entry) => {
        try {
          if (signal?.aborted) throw Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' });
          const validated = validateZipEntry(entry, limits);
          processedEntries += 1;
          if (processedEntries > limits.maxFiles) throw new Error('Archive contains too many entries.');
          if (!validated.skip) {
            assertNoArchivePathCollision(seenPaths, validated);
            seenPaths.set(validated.collisionKey, { path: validated.path, directory: validated.directory });
            totalSize += entry.uncompressedSize;
            if (totalSize > limits.maxTotalSize) throw new Error('Archive expands beyond the configured size limit.');
            const target = safeJoin(destination, validated.path);
            if (validated.directory) {
              await mkdir(target, { recursive: true });
            } else {
              await mkdir(path.dirname(target), { recursive: true });
              const stream = await openEntryStream(zip, entry);
              const output = createWriteStream(target, { mode: validated.mode || 0o644, flags: 'wx' });
              if (signal) await pipeline(stream, output, { signal });
              else await pipeline(stream, output);
              if (validated.mode) await chmod(target, validated.mode);
              entries.push({
                path: validated.path,
                absolutePath: target,
                size: entry.uncompressedSize,
                mode: validated.mode || 0o644,
              });
            }
          }
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  const wrapperPrefix = detectSingleWrapper(entries.map((entry) => entry.path));
  const rootPrefix = wrapperPrefix && containsProjectMarker(entries.map((entry) => entry.path), wrapperPrefix)
    ? wrapperPrefix
    : null;
  const root = rootPrefix ? path.join(destination, rootPrefix) : destination;
  return {
    archivePath,
    destination,
    root,
    rootPrefix,
    wrapperPrefix,
    entries: entries.map((entry) => ({ ...entry, relativePath: stripPrefix(entry.path, rootPrefix) })),
    fileCount: entries.length,
    totalSize,
  };
}

function openZip(target) {
  return new Promise((resolve, reject) => {
    yauzl.open(target, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
}


function assertNoArchivePathCollision(seenPaths, entry) {
  if (seenPaths.has(entry.collisionKey)) {
    throw new Error(`Archive contains duplicate or case-colliding paths, including Unicode-equivalent names: ${entry.path}`);
  }
  const segments = entry.path.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join('/').normalize('NFKC').toLocaleLowerCase('en-US');
    const existing = seenPaths.get(ancestor);
    if (existing && !existing.directory) {
      throw new Error(`Archive path is nested below a file entry: ${entry.path}`);
    }
  }
  if (!entry.directory) {
    const prefix = `${entry.collisionKey}/`;
    for (const key of seenPaths.keys()) {
      if (key.startsWith(prefix)) throw new Error(`Archive file collides with an existing directory path: ${entry.path}`);
    }
  }
}

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(prefix)) throw new Error(`Archive path escapes extraction root: ${relative}`);
  return target;
}

export function rebaseExtractedArchive(extracted, rootPrefix = null) {
  const prefix = rootPrefix || null;
  return {
    ...extracted,
    root: prefix ? path.join(extracted.destination, prefix) : extracted.destination,
    rootPrefix: prefix,
    entries: extracted.entries.map((entry) => ({
      ...entry,
      relativePath: stripPrefix(entry.path, prefix),
    })),
  };
}

function detectSingleWrapper(paths) {
  if (!paths.length) return null;
  const firstSegments = new Set(paths.map((value) => value.split('/')[0]));
  if (firstSegments.size !== 1 || paths.some((value) => !value.includes('/'))) return null;
  return [...firstSegments][0];
}

function containsProjectMarker(paths, prefix) {
  const stripped = paths.map((value) => value.slice(prefix.length + 1));
  const exactMarkers = new Set([
    'package.json', 'pyproject.toml', 'requirements.txt', 'CMakeLists.txt',
    'go.mod', 'go.work', 'Package.swift', 'Cargo.toml',
  ]);
  return stripped.some((value) => exactMarkers.has(value)
    || /^[^/]+\.xcodeproj\/project\.pbxproj$/i.test(value)
    || /^[^/]+\.xcworkspace\/contents\.xcworkspacedata$/i.test(value));
}

function stripPrefix(value, prefix) {
  if (!prefix) return value;
  return value.startsWith(`${prefix}/`) ? value.slice(prefix.length + 1) : value;
}
