import path from 'node:path';

export const DEFAULT_UNIX_SOCKET_DIRECTORY = '/tmp';
export const DEFAULT_UNIX_SOCKET_NAME = 'api-v1.sock';
export const DARWIN_UNIX_SOCKET_MAX_BYTES = 103;
export const LINUX_UNIX_SOCKET_MAX_BYTES = 107;

export function createLocalEndpoint({
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  identity = process.env.USERNAME ?? process.env.USER ?? 'user',
  socketDirectory = null,
  socketPath = null,
  pipeName = null,
} = {}) {
  if (platform === 'win32') {
    const explicit = socketPath === null ? null : String(socketPath);
    if (explicit && !isNamedPipePath(explicit)) {
      throw endpointError('An explicit Windows socketPath must be a named-pipe path.');
    }
    const name = sanitizePipeName(pipeName ?? `zipflow-${identity}-api-v1`);
    const listenPath = explicit ?? `\\\\.\\pipe\\${name}`;
    return Object.freeze({
      kind: 'named-pipe',
      listenPath,
      socketPath: listenPath,
      socketDirectory: null,
      platform,
    });
  }

  if (!Number.isInteger(uid) || uid < 0) {
    throw endpointError('A numeric user ID is required for a Unix endpoint.');
  }
  const explicitSocketPath = socketPath === null ? null : path.resolve(socketPath);
  const directory = path.resolve(
    socketDirectory
      ?? (explicitSocketPath ? path.dirname(explicitSocketPath) : path.join(DEFAULT_UNIX_SOCKET_DIRECTORY, `zipflow-${uid}`)),
  );
  const listenPath = explicitSocketPath ?? path.join(directory, DEFAULT_UNIX_SOCKET_NAME);
  if (path.dirname(listenPath) !== directory) {
    throw endpointError('The Unix socket must be directly inside its validated socket directory.');
  }
  assertUnixSocketLength(listenPath, { platform });
  return Object.freeze({
    kind: 'unix',
    listenPath,
    socketPath: listenPath,
    socketDirectory: directory,
    platform,
    uid,
  });
}

export function normalizeListenTarget(endpoint) {
  if (!endpoint || !['unix', 'named-pipe'].includes(endpoint.kind) || !endpoint.listenPath) {
    throw endpointError('A valid local endpoint is required.');
  }
  if (endpoint.kind === 'named-pipe' && !isNamedPipePath(endpoint.listenPath)) {
    throw endpointError('A Windows endpoint must use a named-pipe path.');
  }
  if (endpoint.kind === 'unix' && !path.isAbsolute(endpoint.listenPath)) {
    throw endpointError('A Unix endpoint path must be absolute.');
  }
  return endpoint.listenPath;
}

export function assertUnixSocketLength(socketPath, { platform = process.platform } = {}) {
  const maximum = platform === 'darwin' ? DARWIN_UNIX_SOCKET_MAX_BYTES : LINUX_UNIX_SOCKET_MAX_BYTES;
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > maximum) {
    throw endpointError(`Unix socket path is ${bytes} bytes; the supported maximum is ${maximum}.`, 'SOCKET_PATH_TOO_LONG');
  }
  return socketPath;
}

export function isNamedPipePath(value) {
  return typeof value === 'string' && /^\\\\\.\\pipe\\[^\\/]+$/i.test(value);
}

function sanitizePipeName(value) {
  const name = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) throw endpointError('A Windows named-pipe name is required.');
  return name.slice(0, 128);
}

function endpointError(message, code = 'INVALID_LOCAL_ENDPOINT') {
  return Object.assign(new Error(message), { code });
}
