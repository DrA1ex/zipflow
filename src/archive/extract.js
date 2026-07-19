import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { ensureDir } from '../utils/fs.js';
import { DEFAULT_ARCHIVE_LIMITS, validateZipEntry } from './security.js';

export async function extractArchive(archivePath, destination, { limits = DEFAULT_ARCHIVE_LIMITS } = {}) {
  await rm(destination, { recursive: true, force: true });
  await ensureDir(destination);
  const zip = await openZip(archivePath);
  const entries = [];
  const seenPaths = new Set();
  let processedEntries = 0;
  let totalSize = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', async (entry) => {
        try {
          const validated = validateZipEntry(entry, limits);
          processedEntries += 1;
          if (processedEntries > limits.maxFiles) throw new Error('Archive contains too many entries.');
          if (!validated.skip) {
            const collisionKey = validated.path.toLocaleLowerCase('en-US');
            if (seenPaths.has(collisionKey)) throw new Error(`Archive contains duplicate or case-colliding paths: ${validated.path}`);
            seenPaths.add(collisionKey);
            totalSize += entry.uncompressedSize;
            if (totalSize > limits.maxTotalSize) throw new Error('Archive expands beyond the configured size limit.');
            const target = safeJoin(destination, validated.path);
            if (validated.directory) {
              await mkdir(target, { recursive: true });
            } else {
              await mkdir(path.dirname(target), { recursive: true });
              const stream = await openEntryStream(zip, entry);
              await pipeline(stream, createWriteStream(target, { mode: validated.mode || 0o644 }));
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
  const rootPrefix = detectSingleRoot(entries.map((entry) => entry.path));
  const root = rootPrefix ? path.join(destination, rootPrefix) : destination;
  return {
    archivePath,
    destination,
    root,
    rootPrefix,
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

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(prefix)) throw new Error(`Archive path escapes extraction root: ${relative}`);
  return target;
}

function detectSingleRoot(paths) {
  if (!paths.length) return null;
  const firstSegments = new Set(paths.map((value) => value.split('/')[0]));
  if (firstSegments.size !== 1 || paths.some((value) => !value.includes('/'))) return null;
  const segment = [...firstSegments][0];
  const markers = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'CMakeLists.txt', 'go.mod', 'go.work']);
  const stripped = paths.map((value) => value.slice(segment.length + 1));
  return stripped.some((value) => markers.has(value)) ? segment : null;
}

function stripPrefix(value, prefix) {
  if (!prefix) return value;
  return value.startsWith(`${prefix}/`) ? value.slice(prefix.length + 1) : value;
}
