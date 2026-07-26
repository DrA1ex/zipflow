import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureDir(target) {
  await mkdir(target, { recursive: true });
  return target;
}

export async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(target, value) {
  await writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(target, value) {
  await writeAtomic(target, value);
}

export async function writeJsonDurableAtomic(target, value) {
  await writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`, { durable: true });
}

export async function writeTextDurableAtomic(target, value) {
  await writeAtomic(target, value, { durable: true });
}

async function writeAtomic(target, value, { durable = false } = {}) {
  const parent = path.dirname(target);
  await ensureDir(parent);
  const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(value, 'utf8');
    if (durable) await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    if (durable) await syncDirectory(parent);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function syncFile(target) {
  let handle = null;
  try {
    handle = await open(target, 'r');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function syncDirectory(target) {
  let handle = null;
  try {
    handle = await open(target, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function walkFiles(root, { include = () => true, descend = () => true, onVisit = null, signal = null } = {}) {
  const files = [];
  async function visit(directory, relativeDirectory = '') {
    throwIfAborted(signal);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      throwIfAborted(signal);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      onVisit?.({ relative, kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', files: files.length });
      if (entry.isDirectory()) {
        if (descend(relative)) await visit(absolute, relative);
      } else if (entry.isFile() && include(relative)) {
        files.push(relative);
      }
    }
  }
  await visit(root);
  files.sort();
  return files;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Operation cancelled.');
  error.code = 'cancelled';
  throw error;
}

export async function removeIfExists(target) {
  await rm(target, { recursive: true, force: true });
}
