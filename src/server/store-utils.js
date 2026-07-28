import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile } from 'node:fs/promises';

export async function ensurePrivateStorageRoot(target) {
  let created = false;
  try {
    await mkdir(target, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const details = await lstat(target);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw storeError('Server storage root must be a real directory.', 'SERVER_STORAGE_UNSAFE', target);
  }
  if (typeof process.getuid === 'function' && details.uid !== process.getuid()) {
    throw storeError('Server storage root must be owned by the current user.', 'SERVER_STORAGE_UNSAFE', target);
  }
  if (created) await chmod(target, 0o700);
  else if ((details.mode & 0o077) !== 0) {
    throw storeError('Server storage root must not be accessible to group or other users.', 'SERVER_STORAGE_UNSAFE', target);
  }
  return target;
}

export async function readJsonStrict(target, fallback = null) {
  let source;
  try {
    source = await readFile(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw Object.assign(new Error(`Server storage record is not valid JSON: ${target}`, { cause: error }), {
      code: 'SERVER_STORAGE_CORRUPT',
      path: target,
    });
  }
}

export async function listJsonFiles(target) {
  const entries = await readdir(target, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

export function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

export function requestFingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export class KeyedSerialQueue {
  constructor() {
    this.pending = new Map();
  }

  run(key, callback) {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    const tracked = current.catch(() => {}).finally(() => {
      if (this.pending.get(key) === tracked) this.pending.delete(key);
    });
    this.pending.set(key, tracked);
    return current;
  }
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = sortJson(value[key]);
  }
  return result;
}

function storeError(message, code, target) {
  return Object.assign(new Error(message), { code, path: target });
}
