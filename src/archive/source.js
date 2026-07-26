import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { hashFile } from '../utils/hash.js';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const COPY_BUFFER_BYTES = 1024 * 1024;

export async function openArchiveSource(archivePath, { signal = null } = {}) {
  const lexical = path.resolve(archivePath);
  const before = await lstat(lexical, { bigint: true }).catch((error) => {
    throw archiveInputError(error?.code === 'ENOENT' ? 'Archive file was not found.' : error.message);
  });
  if (before.isSymbolicLink()) throw archiveInputError('The selected ZIP path is a symbolic link. Choose the real archive file instead.');
  if (!before.isFile()) throw archiveInputError('Archive path is not a regular file.');

  const canonical = await realpath(lexical);
  const sourceHandle = await open(canonical, constants.O_RDONLY | NOFOLLOW);
  let snapshotDirectory = null;
  let closed = false;
  try {
    const opened = await sourceHandle.stat({ bigint: true });
    if (!opened.isFile()) throw archiveInputError('Archive path is not a regular file.');
    if (!sameFile(before, opened)) throw archiveChangedError('Archive identity changed while it was being opened. Select the ZIP again.');
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw archiveInputError('Archive file is too large to process safely on this runtime.');
    }

    snapshotDirectory = await mkdtemp(path.join(os.tmpdir(), 'zipflow-archive-'));
    await chmod(snapshotDirectory, 0o700).catch(() => {});
    const snapshotPath = path.join(snapshotDirectory, 'source.zip');
    const hash = await copyHandleToPrivateSnapshot(sourceHandle, snapshotPath, { signal });
    const after = await sourceHandle.stat({ bigint: true });
    if (!sameStableSource(opened, after)) {
      throw archiveChangedError('Archive changed while Zipflow was copying it. Select the ZIP again.');
    }
    await sourceHandle.close();

    return {
      path: lexical,
      canonicalPath: canonical,
      snapshotPath,
      hash,
      size: Number(opened.size),
      modifiedAt: new Date(Number(opened.mtimeMs)).toISOString(),
      async verify({ signal: verifySignal = signal, verifyHash = true } = {}) {
        if (!verifyHash) return true;
        const currentHash = await hashFile(snapshotPath, { signal: verifySignal });
        if (currentHash !== hash) {
          throw archiveChangedError('The private archive snapshot changed while Zipflow was reading it. No project files were changed.');
        }
        return true;
      },
      async close() {
        if (closed) return;
        closed = true;
        await rm(snapshotDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await sourceHandle.close().catch(() => {});
    if (snapshotDirectory) await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function withArchiveSource(archivePath, callback, options = {}) {
  const source = await openArchiveSource(archivePath, options);
  try {
    return await callback(source);
  } finally {
    await source.close();
  }
}

async function copyHandleToPrivateSnapshot(sourceHandle, target, { signal = null } = {}) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const targetHandle = await open(target, 'wx', 0o600);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  try {
    while (true) {
      throwIfCancelled(signal);
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(chunk, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw new Error('Could not write the private archive snapshot.');
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
  } finally {
    await targetHandle.close().catch(() => {});
  }
  return hash.digest('hex');
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableSource(left, right) {
  return sameFile(left, right)
    && left.size === right.size
    && timestampNs(left, 'mtime') === timestampNs(right, 'mtime')
    && timestampNs(left, 'ctime') === timestampNs(right, 'ctime');
}

function timestampNs(info, name) {
  const exact = info[`${name}Ns`];
  if (typeof exact === 'bigint') return exact;
  return BigInt(Math.trunc(Number(info[`${name}Ms`] ?? 0) * 1_000_000));
}

function throwIfCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Operation cancelled.');
  error.code = 'cancelled';
  throw error;
}

function archiveInputError(message) {
  const error = new Error(message);
  error.code = 'unsafe_archive_input';
  return error;
}

function archiveChangedError(message) {
  const error = new Error(message);
  error.code = 'archive_identity_changed';
  return error;
}
