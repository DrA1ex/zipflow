import path from 'node:path';
import { createLocalEndpoint } from './endpoint.js';
import { createPosixRuntimeSecurity } from './runtime-security-posix.js';
import { createWindowsRuntimeSecurity } from './runtime-security-windows.js';
import { getZipflowHome } from '../workflow/store.js';

export function resolveServerPaths({
  zipflowHome = getZipflowHome(),
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  socketDirectory = null,
  socketPath = null,
  pipeName = null,
  endpoint = null,
} = {}) {
  const home = path.resolve(zipflowHome);
  const localEndpoint = endpoint ?? createLocalEndpoint({
    platform,
    uid,
    socketDirectory,
    socketPath,
    pipeName,
  });
  const runtimeRoot = path.join(home, 'runtime');
  const serverRoot = path.join(home, 'server');
  return Object.freeze({
    zipflowHome: home,
    runtimeRoot,
    discoveryPath: path.join(runtimeRoot, 'server-v1.json'),
    tokenPath: path.join(runtimeRoot, 'server-v1.token'),
    lockPath: path.join(runtimeRoot, 'server-v1.lock'),
    serverRoot,
    projectsRoot: path.join(serverRoot, 'projects'),
    blobsRoot: path.join(serverRoot, 'blobs'),
    idempotencyRoot: path.join(serverRoot, 'idempotency'),
    operationsRoot: path.join(serverRoot, 'operations'),
    eventsRoot: path.join(serverRoot, 'events'),
    workflowRevisionsRoot: path.join(serverRoot, 'workflow-revisions'),
    runsRoot: path.join(home, 'runs'),
    endpoint: localEndpoint,
    socketDirectory: localEndpoint.socketDirectory,
    socketPath: localEndpoint.socketPath,
  });
}

export function createRuntimeSecurity(paths, options = {}) {
  if (paths.endpoint.kind === 'named-pipe') return createWindowsRuntimeSecurity();
  return createPosixRuntimeSecurity({ uid: options.uid ?? paths.endpoint.uid });
}

export async function ensureRuntimeDirectories(paths, security = createRuntimeSecurity(paths)) {
  await security.ensurePrivateDirectory(paths.zipflowHome);
  await security.ensurePrivateDirectory(paths.runtimeRoot);
  if (paths.endpoint.kind === 'unix') await security.ensurePrivateDirectory(paths.socketDirectory);
  return paths;
}

export async function ensureServerStorageDirectories(paths, security = createRuntimeSecurity(paths)) {
  await security.ensurePrivateDirectory(paths.zipflowHome);
  await security.ensurePrivateDirectory(paths.serverRoot);
  for (const target of [
    paths.projectsRoot,
    paths.blobsRoot,
    paths.idempotencyRoot,
    paths.operationsRoot,
    paths.eventsRoot,
    paths.workflowRevisionsRoot,
    paths.runsRoot,
  ]) {
    await security.ensurePrivateDirectory(target);
  }
  return paths;
}
