import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  open,
  readdir,
  rm,
  unlink,
} from 'node:fs/promises';
import { syncDirectory, writeJsonDurableAtomic } from '../utils/fs.js';
import {
  ensurePrivateStorageRoot,
  KeyedSerialQueue,
  readJsonStrict,
} from './store-utils.js';

export const DEFAULT_BLOB_SIZE_LIMIT = 512 * 1024 * 1024;

export class BlobStore {
  constructor({
    root,
    maxBytes = DEFAULT_BLOB_SIZE_LIMIT,
    now = () => new Date(),
  } = {}) {
    if (!root) throw new TypeError('Blob store root is required.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('Blob size limit must be a positive safe integer.');
    this.root = path.resolve(root);
    this.temporaryRoot = path.join(this.root, '.incoming');
    this.maxBytes = maxBytes;
    this.now = now;
    this.queue = new KeyedSerialQueue();
    this.initialized = false;
  }

  async initialize() {
    await ensurePrivateStorageRoot(this.root);
    await ensurePrivateStorageRoot(this.temporaryRoot);
    await cleanupIncomingFiles(this.temporaryRoot);
    this.initialized = true;
    return this;
  }

  async putStream(stream, {
    contentLength = null,
    filename = 'archive.zip',
    signal = null,
  } = {}) {
    const staged = await this.stageStream(stream, { contentLength, filename, signal });
    try {
      return await staged.publish();
    } finally {
      await staged.discard();
    }
  }

  async stageStream(stream, {
    contentLength = null,
    filename = 'archive.zip',
    signal = null,
  } = {}) {
    await this.ensureInitialized();
    const declared = normalizeLength(contentLength);
    if (declared !== null && declared > this.maxBytes) throw blobError('Blob exceeds the compressed-size limit.', 'BLOB_TOO_LARGE', 413);
    const safeFilename = sanitizeBlobFilename(filename);
    const temporaryPath = path.join(this.temporaryRoot, `${process.pid}-${randomUUID()}.upload`);
    let handle = null;
    let size = 0;
    const hash = createHash('sha256');
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      for await (const value of stream) {
        throwIfAborted(signal);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > this.maxBytes) throw blobError('Blob exceeds the compressed-size limit.', 'BLOB_TOO_LARGE', 413);
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      throwIfAborted(signal);
      if (declared !== null && declared !== size) {
        throw blobError('Content-Length does not match the uploaded blob.', 'CONTENT_LENGTH_MISMATCH', 400);
      }
      await handle.sync();
      await handle.close();
      handle = null;
      const sha256 = hash.digest('hex');
      let discarded = false;
      return Object.freeze({
        sha256,
        size,
        filename: safeFilename,
        blobId: `sha256:${sha256}`,
        publish: async () => {
          if (discarded) throw blobError('Staged blob is no longer available.', 'BLOB_STAGE_CLOSED', 409);
          return this.publish(temporaryPath, {
            sha256,
            size,
            filename: safeFilename,
          });
        },
        discard: async () => {
          if (discarded) return;
          discarded = true;
          await rm(temporaryPath, { force: true });
        },
      });
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async get(blobId) {
    await this.ensureInitialized();
    const sha256 = parseBlobId(blobId);
    const metadata = await readJsonStrict(this.metadataPath(sha256), null);
    if (!metadata) return null;
    validateMetadata(metadata, sha256);
    return {
      ...metadata,
      path: this.blobPath(sha256),
    };
  }

  async open(blobId) {
    const record = await this.get(blobId);
    if (!record) return null;
    const handle = await open(record.path, 'r');
    const details = await handle.stat();
    if (!details.isFile() || details.size !== record.size) {
      await handle.close();
      throw blobError('Stored blob does not match its durable metadata.', 'SERVER_STORAGE_CORRUPT', 500);
    }
    return { record, handle };
  }

  async publish(temporaryPath, value) {
    return this.queue.run(value.sha256, async () => {
      const blobPath = this.blobPath(value.sha256);
      const metadataPath = this.metadataPath(value.sha256);
      let deduplicated = false;
      try {
        await link(temporaryPath, blobPath);
        await syncDirectory(this.root);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        deduplicated = true;
      }

      let metadata = await readJsonStrict(metadataPath, null);
      if (metadata) {
        validateMetadata(metadata, value.sha256);
        if (metadata.size !== value.size) {
          throw blobError('A stored blob hash has inconsistent size metadata.', 'SERVER_STORAGE_CORRUPT', 500);
        }
      } else {
        metadata = {
          version: 1,
          blobId: `sha256:${value.sha256}`,
          sha256: value.sha256,
          size: value.size,
          filename: value.filename,
          createdAt: this.now().toISOString(),
        };
        await writeJsonDurableAtomic(metadataPath, metadata);
      }
      return { ...metadata, deduplicated };
    });
  }

  blobPath(sha256) {
    return path.join(this.root, `${sha256}.zip`);
  }

  metadataPath(sha256) {
    return path.join(this.root, `${sha256}.json`);
  }

  async ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }
}

export async function cleanupIncomingFiles(temporaryRoot) {
  const entries = await readdir(temporaryRoot, { withFileTypes: true });
  const removed = [];
  for (const entry of entries) {
    const target = path.join(temporaryRoot, entry.name);
    const before = await lstat(target).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!before) continue;
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || (typeof process.getuid === 'function' && before.uid !== process.getuid())
      || (before.mode & 0o077) !== 0
    ) {
      throw blobError('Incoming blob storage contains an unsafe node.', 'SERVER_STORAGE_UNSAFE', 500);
    }
    const current = await lstat(target).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!current) continue;
    if (current.dev !== before.dev || current.ino !== before.ino) {
      throw blobError('Incoming blob identity changed during cleanup.', 'SERVER_STORAGE_UNSAFE', 500);
    }
    await unlink(target);
    removed.push(entry.name);
  }
  return removed;
}

export function parseBlobId(blobId) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(String(blobId ?? ''));
  if (!match) throw blobError('Blob ID is invalid.', 'INVALID_BLOB_ID', 400);
  return match[1];
}

export function sanitizeBlobFilename(value) {
  const normalized = String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .at(-1)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  const fallback = 'archive.zip';
  const filename = normalized || fallback;
  const bytes = Buffer.from(filename);
  if (bytes.length <= 255) return filename;
  return bytes.subarray(0, 251).toString('utf8').replace(/\uFFFD+$/g, '') + '.zip';
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (!bytesWritten) throw blobError('Blob storage stopped accepting bytes.', 'BLOB_WRITE_FAILED', 500);
    offset += bytesWritten;
  }
}

function normalizeLength(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw blobError('Content-Length is invalid.', 'INVALID_CONTENT_LENGTH', 400);
  }
  return number;
}

function validateMetadata(metadata, sha256) {
  if (
    metadata?.version !== 1
    || metadata.sha256 !== sha256
    || metadata.blobId !== `sha256:${sha256}`
    || !Number.isSafeInteger(metadata.size)
    || metadata.size < 0
    || typeof metadata.filename !== 'string'
    || !Number.isFinite(Date.parse(metadata.createdAt))
  ) {
    throw blobError('Blob metadata is corrupt.', 'SERVER_STORAGE_CORRUPT', 500);
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw blobError('Blob upload was cancelled.', 'CANCELLED', 499);
}

function blobError(message, code, status) {
  return Object.assign(new Error(message), { code, status, expose: status < 500, detail: message });
}
