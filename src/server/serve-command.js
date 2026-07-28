import { startZipflowServer } from './server.js';
import { resolveServerPaths } from './runtime-paths.js';

export function parseServeArguments(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('Serve arguments must be an array.');
  let socketPath = null;
  let idleTimeoutMs = 0;
  let socketSeen = false;
  let idleTimeoutSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--socket') {
      if (socketSeen) throw serveArgumentError('--socket may be specified only once.');
      socketSeen = true;
      socketPath = requiredOptionValue('--socket', argv[index + 1]);
      index += 1;
      continue;
    }
    if (typeof argument === 'string' && argument.startsWith('--socket=')) {
      if (socketSeen) throw serveArgumentError('--socket may be specified only once.');
      socketSeen = true;
      socketPath = requiredOptionValue('--socket', argument.slice('--socket='.length));
      continue;
    }
    if (argument === '--idle-timeout-ms') {
      if (idleTimeoutSeen) throw serveArgumentError('--idle-timeout-ms may be specified only once.');
      idleTimeoutSeen = true;
      idleTimeoutMs = parseIdleTimeout(argv[index + 1]);
      index += 1;
      continue;
    }
    if (typeof argument === 'string' && argument.startsWith('--idle-timeout-ms=')) {
      if (idleTimeoutSeen) throw serveArgumentError('--idle-timeout-ms may be specified only once.');
      idleTimeoutSeen = true;
      idleTimeoutMs = parseIdleTimeout(argument.slice('--idle-timeout-ms='.length));
      continue;
    }
    throw serveArgumentError(`Unknown zipflow serve argument: ${String(argument)}`);
  }

  return Object.freeze({ socketPath, idleTimeoutMs });
}

export function createServeServerOptions({ socketPath = null, idleTimeoutMs = 0 } = {}, {
  zipflowHome = undefined,
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const paths = resolveServerPaths({
    ...(zipflowHome === undefined ? {} : { zipflowHome }),
    platform,
    uid,
    ...(socketPath === null ? {} : { socketPath }),
  });
  return Object.freeze({ paths, idleTimeoutMs });
}

export async function runZipflowServe({
  argv = process.argv.slice(3),
  processObject = process,
  startServer = startZipflowServer,
  zipflowHome = undefined,
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  onShutdownError = defaultShutdownError,
} = {}) {
  const parsed = parseServeArguments(argv);
  const options = createServeServerOptions(parsed, { zipflowHome, platform, uid });
  const server = await startServer(options);
  if (!server.reused) {
    installServeSignalHandlers(server, { processObject, onShutdownError });
  }
  return server;
}

export function installServeSignalHandlers(server, {
  processObject = process,
  onShutdownError = defaultShutdownError,
} = {}) {
  if (!server || typeof server.close !== 'function') {
    throw new TypeError('A closeable Zipflow server is required.');
  }
  let closing = null;
  const detach = () => {
    processObject.off('SIGINT', handleSignal);
    processObject.off('SIGTERM', handleSignal);
  };
  const handleSignal = (signal) => {
    if (closing) return;
    closing = Promise.resolve()
      .then(() => server.close())
      .then(detach)
      .catch((error) => {
        closing = null;
        onShutdownError(error, { signal });
      });
  };
  processObject.on('SIGINT', handleSignal);
  processObject.on('SIGTERM', handleSignal);
  return detach;
}

function requiredOptionValue(name, value) {
  if (typeof value !== 'string' || !value || value.startsWith('--') || /[\0\r\n]/.test(value)) {
    throw serveArgumentError(`${name} requires a value.`);
  }
  return value;
}

function parseIdleTimeout(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw serveArgumentError('--idle-timeout-ms must be a non-negative integer.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw serveArgumentError('--idle-timeout-ms must be a safe integer.');
  }
  return parsed;
}

function serveArgumentError(message) {
  return Object.assign(new Error(message), { code: 'INVALID_SERVE_ARGUMENT' });
}

function defaultShutdownError(error) {
  process.stderr.write(`Zipflow server shutdown failed: ${error.message}\n`);
}
