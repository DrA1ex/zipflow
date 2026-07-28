const UNIX_SCHEME = 'unix://';
const WINDOWS_PIPE_PREFIXES = ['\\\\.\\pipe\\', '\\\\?\\pipe\\'];

export function normalizeLocalEndpoint(input) {
  const declaredKind = isObject(input) ? input.kind ?? input.type ?? null : null;
  const raw = isObject(input)
    ? input.socketPath ?? input.path ?? input.endpoint
    : input;
  if (typeof raw !== 'string') throw new TypeError('A local socket or named-pipe path is required.');
  let socketPath = raw;
  if (socketPath.startsWith(UNIX_SCHEME)) socketPath = decodeUnixEndpoint(socketPath);
  validatePathText(socketPath);

  const detectedKind = isWindowsNamedPipePath(socketPath)
    ? 'named-pipe'
    : socketPath.startsWith('/')
      ? 'unix'
      : null;
  if (!detectedKind) {
    throw new TypeError('The local endpoint must be an absolute Unix socket path or a Windows named-pipe path.');
  }
  if (declaredKind && normalizeKind(declaredKind) !== detectedKind) {
    throw new TypeError(`Local endpoint kind ${declaredKind} does not match ${socketPath}.`);
  }
  return Object.freeze({ kind: detectedKind, socketPath });
}

export function isWindowsNamedPipePath(value) {
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return WINDOWS_PIPE_PREFIXES.some((prefix) => lower.startsWith(prefix) && value.length > prefix.length);
}

export function isUnixSocketPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
}

function decodeUnixEndpoint(endpoint) {
  const encoded = endpoint.slice(UNIX_SCHEME.length);
  let decoded;
  try { decoded = decodeURIComponent(encoded); } catch {
    throw new TypeError('The Unix endpoint contains invalid percent encoding.');
  }
  if (!decoded.startsWith('/')) throw new TypeError('A unix:// endpoint must contain an absolute path.');
  return decoded;
}

function normalizeKind(kind) {
  if (kind === 'unix' || kind === 'unix-socket') return 'unix';
  if (kind === 'named-pipe' || kind === 'windows-pipe') return 'named-pipe';
  throw new TypeError(`Unsupported local endpoint kind: ${kind}`);
}

function validatePathText(value) {
  if (!value || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new TypeError('The local endpoint path is empty or contains unsafe characters.');
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
