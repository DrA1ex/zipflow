import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { ensureDir } from '../utils/fs.js';
import { assertArchiveExtractionSpace } from '../storage/disk-space.js';
import { openArchiveSource } from './source.js';
import { DEFAULT_ARCHIVE_LIMITS, validateZipEntry } from './security.js';

export async function extractArchive(archivePath, destination, options = {}) {
  const source = await openArchiveSource(archivePath, { signal: options.signal ?? null });
  try {
    return await extractArchiveFromSource(source, destination, options);
  } finally {
    await source.close();
  }
}

export async function extractArchiveFromSource(source, destination, {
  limits = DEFAULT_ARCHIVE_LIMITS,
  signal = null,
  diskSpaceProbe = undefined,
} = {}) {
  const scanned = await scanArchiveSource(source, { limits, signal });
  await assertArchiveExtractionSpace({
    destination,
    archiveBytes: source.size,
    expandedBytes: scanned.totalSize,
    entryCount: scanned.processedEntries,
    ...(diskSpaceProbe ? { probe: diskSpaceProbe } : {}),
  });

  let completed = false;
  await rm(destination, { recursive: true, force: true });
  await ensureDir(destination);
  try {
    const extracted = await extractScannedArchive(source, destination, scanned, { limits, signal });
    await source.verify({ signal, verifyHash: true });
    completed = true;
    return {
      ...extracted,
      archivePath: source.path,
      archiveHash: source.hash,
      archiveInfo: { size: source.size, modifiedAt: source.modifiedAt },
    };
  } finally {
    if (!completed) await rm(destination, { recursive: true, force: true }).catch(() => {});
  }
}

export async function scanArchiveSource(source, { limits = DEFAULT_ARCHIVE_LIMITS, signal = null } = {}) {
  const entries = [];
  const seenPaths = new Map();
  let processedEntries = 0;
  let totalSize = 0;
  await consumeZip(source, async (entry) => {
    throwIfCancelled(signal);
    const validated = validateZipEntry(entry, limits);
    processedEntries += 1;
    if (processedEntries > limits.maxFiles) throw new Error('Archive contains too many entries.');
    if (!validated.skip) {
      assertNoArchivePathCollision(seenPaths, validated);
      seenPaths.set(validated.collisionKey, { path: validated.path, directory: validated.directory });
      totalSize += Number(entry.uncompressedSize);
      if (totalSize > limits.maxTotalSize) throw new Error('Archive expands beyond the configured size limit.');
    }
    entries.push(entrySignature(entry, validated));
  });
  return { entries, processedEntries, totalSize };
}

async function extractScannedArchive(source, destination, scanned, { limits, signal }) {
  const entries = [];
  let index = 0;
  let totalSize = 0;
  await consumeZip(source, async (entry, zip) => {
    throwIfCancelled(signal);
    const validated = validateZipEntry(entry, limits);
    const expected = scanned.entries[index];
    const actual = entrySignature(entry, validated);
    if (!expected || !sameEntrySignature(expected, actual)) {
      throw archiveChangedError(`Archive entry metadata changed while reading ${validated.path}.`);
    }
    index += 1;
    if (validated.skip) return;
    totalSize += Number(entry.uncompressedSize);
    const target = safeJoin(destination, validated.path);
    if (validated.directory) {
      await mkdir(target, { recursive: true });
      return;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const stream = await openEntryStream(zip, entry);
    const output = createWriteStream(target, { mode: validated.mode ?? 0o644, flags: 'wx' });
    if (signal) await pipeline(stream, output, { signal });
    else await pipeline(stream, output);
    if (validated.mode !== null) await chmod(target, validated.mode);
    entries.push({
      path: validated.path,
      absolutePath: target,
      size: Number(entry.uncompressedSize),
      mode: validated.mode,
    });
  });
  if (index !== scanned.entries.length) throw archiveChangedError('Archive entry count changed while Zipflow was reading it.');
  const wrapperPrefix = detectSingleWrapper(entries.map((entry) => entry.path));
  const rootPrefix = wrapperPrefix && containsProjectMarker(entries.map((entry) => entry.path), wrapperPrefix)
    ? wrapperPrefix
    : null;
  const root = rootPrefix ? path.join(destination, rootPrefix) : destination;
  return {
    destination,
    root,
    rootPrefix,
    wrapperPrefix,
    entries: entries.map((entry) => ({ ...entry, relativePath: stripPrefix(entry.path, rootPrefix) })),
    fileCount: entries.length,
    totalSize,
  };
}

function consumeZip(source, onEntry) {
  return new Promise((resolve, reject) => {
    openZipFromSource(source).then((zip) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (error) {
          try { zip.close(); } catch {}
          reject(error);
        } else resolve();
      };
      zip.on('error', finish);
      zip.on('end', () => finish());
      zip.on('entry', (entry) => {
        Promise.resolve(onEntry(entry, zip)).then(() => {
          if (!settled) zip.readEntry();
        }, finish);
      });
      zip.readEntry();
    }, reject);
  });
}

function openZipFromSource(source) {
  return new Promise((resolve, reject) => {
    yauzl.open(source.snapshotPath, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      autoClose: true,
    }, (error, zip) => {
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

function entrySignature(entry, validated) {
  return {
    path: validated.path,
    collisionKey: validated.collisionKey,
    directory: validated.directory,
    skip: validated.skip,
    mode: validated.mode,
    compressedSize: Number(entry.compressedSize),
    uncompressedSize: Number(entry.uncompressedSize),
    crc32: Number(entry.crc32 ?? 0),
    compressionMethod: Number(entry.compressionMethod ?? 0),
    generalPurposeBitFlag: Number(entry.generalPurposeBitFlag ?? 0),
    externalFileAttributes: Number(entry.externalFileAttributes ?? 0),
    relativeOffsetOfLocalHeader: Number(entry.relativeOffsetOfLocalHeader ?? 0),
    versionMadeBy: Number(entry.versionMadeBy ?? 0),
  };
}

function sameEntrySignature(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
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

function throwIfCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Operation cancelled.');
  error.code = 'cancelled';
  throw error;
}

function archiveChangedError(message) {
  const error = new Error(message);
  error.code = 'archive_identity_changed';
  return error;
}
