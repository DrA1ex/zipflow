import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class RuntimeSecurityError extends Error {
  constructor(message, { code = 'RUNTIME_SECURITY', path = null } = {}) {
    super(message);
    this.name = 'RuntimeSecurityError';
    this.code = code;
    this.path = path;
  }
}

export function createPosixRuntimeSecurity({
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  openFile = open,
} = {}) {
  if (!Number.isInteger(uid) || uid < 0) {
    throw new RuntimeSecurityError('POSIX runtime security requires a numeric current UID.');
  }

  return Object.freeze({
    kind: 'posix',
    uid,
    ensurePrivateDirectory: (target) => ensurePrivateDirectory(target, { uid }),
    assertPrivateDirectory: (target, options) => assertOwnedNode(target, { uid, kind: 'directory', mode: 0o700, ...options }),
    assertPrivateFile: (target, options) => assertOwnedNode(target, { uid, kind: 'file', mode: 0o600, ...options }),
    assertPrivateSocket: (target, options) => assertOwnedNode(target, { uid, kind: 'socket', mode: 0o600, ...options }),
    createExclusiveFile: (target, value) => createExclusiveFile(target, value, { uid, openFile }),
    readPrivateFile: (target, options) => readPrivateFile(target, { uid, openFile, ...options }),
    removeExact: (target, options) => removeExact(target, { uid, ...options }),
    secureSocket: (target) => secureSocket(target, { uid }),
  });
}

async function ensurePrivateDirectory(target, { uid }) {
  let created = false;
  try {
    await mkdir(target, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (created) {
    await chmod(target, 0o700);
  } else {
    // ZIPFLOW_HOME is commonly created by a shell or temporary-directory
    // helper before the server starts. Narrow an existing directory owned by
    // this user instead of rejecting the otherwise safe first startup. Open
    // with O_NOFOLLOW and chmod the handle so a path substitution cannot turn
    // this repair into a symlink-following write.
    const before = await assertOwnedNode(target, {
      uid,
      kind: 'directory',
      mode: null,
    });
    let handle = null;
    try {
      handle = await open(target, constants.O_RDONLY | NOFOLLOW);
      const opened = await handle.stat();
      assertOwnedStats(opened, { uid, kind: 'directory', mode: null, target });
      if (!sameIdentity(before, opened)) throw changedPath(target);
      await handle.chmod(0o700);
      const secured = await handle.stat();
      assertOwnedStats(secured, { uid, kind: 'directory', mode: 0o700, target });
      if (!sameIdentity(opened, secured)) throw changedPath(target);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return assertOwnedNode(target, { uid, kind: 'directory', mode: 0o700 });
}

async function createExclusiveFile(target, value, { uid, openFile }) {
  let handle = null;
  let openedDetails = null;
  let completed = false;
  try {
    handle = await openFile(target, 'wx', 0o600);
    openedDetails = await handle.stat();
    await handle.writeFile(String(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(target, 0o600);
    await assertOwnedNode(target, { uid, kind: 'file', mode: 0o600 });
    completed = true;
  } finally {
    await handle?.close().catch(() => {});
    if (!completed && openedDetails) await unlinkMatchingIdentity(target, openedDetails).catch(() => {});
  }
}

async function readPrivateFile(target, { uid, openFile, optional = false } = {}) {
  const snapshot = await readPrivateFileSnapshot(target, { uid, openFile, optional });
  return snapshot?.text ?? null;
}

async function secureSocket(target, { uid }) {
  await chmod(target, 0o600);
  return assertOwnedNode(target, { uid, kind: 'socket', mode: 0o600 });
}

async function removeExact(target, {
  uid,
  kind = 'file',
  optional = true,
  expectedText = null,
} = {}) {
  const details = await assertOwnedNode(target, {
    uid,
    kind,
    mode: kind === 'directory' ? 0o700 : 0o600,
    optional,
  });
  if (!details) return false;
  if (expectedText !== null) {
    if (kind !== 'file') throw new RuntimeSecurityError('Content matching is supported only for runtime files.', { path: target });
    const snapshot = await readPrivateFileSnapshot(target, { uid, openFile: open, optional: false });
    if (snapshot.text !== expectedText) {
      throw new RuntimeSecurityError('Runtime file changed while exact cleanup was being validated.', {
        code: 'RUNTIME_PATH_CHANGED',
        path: target,
      });
    }
    if (!sameIdentity(details, snapshot.details)) throw changedPath(target);
  }
  const beforeUnlink = await lstat(target);
  if (!sameIdentity(details, beforeUnlink)) throw changedPath(target);
  await unlink(target);
  return true;
}

async function readPrivateFileSnapshot(target, {
  uid,
  openFile,
  optional,
}) {
  let before;
  try {
    before = await assertOwnedNode(target, { uid, kind: 'file', mode: 0o600, optional });
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!before) return null;
  let handle = null;
  try {
    handle = await openFile(target, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    assertOwnedStats(opened, { uid, kind: 'file', mode: 0o600, target });
    if (!sameIdentity(before, opened)) throw changedPath(target);
    const text = await handle.readFile('utf8');
    const after = await handle.stat();
    if (!sameStableIdentity(opened, after)) throw changedPath(target);
    return { text, details: after };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertOwnedNode(target, {
  uid,
  kind,
  mode,
  optional = false,
} = {}) {
  let details;
  try {
    details = await lstat(target);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (details.isSymbolicLink()) {
    throw new RuntimeSecurityError('Runtime paths must not be symbolic links.', {
      code: 'RUNTIME_SYMLINK_REJECTED',
      path: target,
    });
  }
  assertOwnedStats(details, { uid, kind, mode, target });
  return details;
}

function assertOwnedStats(details, { uid, kind, mode, target }) {
  if (details.uid !== uid) {
    throw new RuntimeSecurityError('Runtime path is not owned by the current user.', {
      code: 'RUNTIME_OWNER_MISMATCH',
      path: target,
    });
  }
  if (!matchesKind(details, kind)) {
    throw new RuntimeSecurityError(`Runtime path is not a ${kind}.`, {
      code: 'RUNTIME_TYPE_MISMATCH',
      path: target,
    });
  }
  const actualMode = details.mode & 0o777;
  if (mode != null && actualMode !== mode) {
    throw new RuntimeSecurityError(
      `Runtime ${kind} permissions must be ${mode.toString(8)}; received ${actualMode.toString(8)}.`,
      { code: 'RUNTIME_MODE_MISMATCH', path: target },
    );
  }
}

function matchesKind(details, kind) {
  if (kind === 'directory') return details.isDirectory();
  if (kind === 'file') return details.isFile();
  if (kind === 'socket') return details.isSocket();
  return false;
}

async function unlinkMatchingIdentity(target, expected) {
  const current = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!current || !sameIdentity(current, expected)) return false;
  await unlink(target);
  return true;
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameStableIdentity(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function changedPath(target) {
  return new RuntimeSecurityError('Runtime path identity changed during validation.', {
    code: 'RUNTIME_PATH_CHANGED',
    path: target,
  });
}
