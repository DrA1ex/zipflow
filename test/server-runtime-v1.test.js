import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  createLocalEndpoint,
  DARWIN_UNIX_SOCKET_MAX_BYTES,
  isNamedPipePath,
} from '../src/server/endpoint.js';
import { ServerLifecycle } from '../src/server/lifecycle.js';
import {
  createRuntimeSecurity,
  ensureRuntimeDirectories,
  resolveServerPaths,
} from '../src/server/runtime-paths.js';
import { createPosixRuntimeSecurity } from '../src/server/runtime-security-posix.js';
import { createWindowsRuntimeSecurity } from '../src/server/runtime-security-windows.js';

test('local endpoint keeps POSIX security outside the named-pipe transport boundary', () => {
  const unix = createLocalEndpoint({ platform: 'darwin', uid: 501 });
  assert.equal(unix.socketDirectory, '/tmp/zipflow-501');
  assert.equal(unix.listenPath, '/tmp/zipflow-501/api-v1.sock');

  const pipe = createLocalEndpoint({ platform: 'win32', identity: 'test user' });
  assert.equal(pipe.kind, 'named-pipe');
  assert.equal(isNamedPipePath(pipe.listenPath), true);
  assert.equal(pipe.socketDirectory, null);
  const explicitPipe = '\\\\.\\pipe\\zipflow-explicit';
  assert.equal(
    createLocalEndpoint({ platform: 'win32', socketPath: explicitPipe }).listenPath,
    explicitPipe,
  );
  assert.throws(
    () => createLocalEndpoint({ platform: 'win32', socketPath: 'C:\\temp\\zipflow.sock' }),
    (error) => error?.code === 'INVALID_LOCAL_ENDPOINT',
  );

  const custom = createLocalEndpoint({
    platform: 'darwin',
    uid: 501,
    socketPath: '/tmp/zipflow-custom/custom.sock',
  });
  assert.equal(custom.socketDirectory, '/tmp/zipflow-custom');
  assert.equal(custom.listenPath, '/tmp/zipflow-custom/custom.sock');

  const oversized = `/${'x'.repeat(DARWIN_UNIX_SOCKET_MAX_BYTES)}`;
  assert.throws(
    () => createLocalEndpoint({
      platform: 'darwin',
      uid: 501,
      socketDirectory: path.dirname(oversized),
      socketPath: oversized,
    }),
    (error) => error?.code === 'SOCKET_PATH_TOO_LONG',
  );
});

test('Windows runtime-security boundary is explicit and fail-closed', () => {
  const security = createWindowsRuntimeSecurity();
  assert.equal(security.kind, 'windows-fail-closed');
  assert.throws(
    () => security.ensurePrivateDirectory('ignored'),
    (error) => error?.code === 'WINDOWS_RUNTIME_SECURITY_UNAVAILABLE',
  );
});

test('exclusive runtime creation cleans a partial lock after write failure', async (t) => {
  const home = await temporaryDirectory(t, 'zipflow-server-partial-lock-');
  const target = path.join(home, 'server-v1.lock');
  const security = createPosixRuntimeSecurity({
    openFile: async (...arguments_) => {
      const handle = await open(...arguments_);
      return {
        stat: (...args) => handle.stat(...args),
        writeFile: async () => {
          throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
        },
        sync: (...args) => handle.sync(...args),
        close: (...args) => handle.close(...args),
      };
    },
  });
  await assert.rejects(security.createExclusiveFile(target, 'partial'), { code: 'EIO' });
  await assert.rejects(lstat(target), { code: 'ENOENT' });
});

test('runtime paths are private and reject symbolic-link substitution', async (t) => {
  const home = await temporaryDirectory(t, 'zipflow-server-paths-');
  const socketDirectory = path.join(home, 'socket');
  const paths = resolveServerPaths({ zipflowHome: home, socketDirectory });
  const security = createRuntimeSecurity(paths);
  await ensureRuntimeDirectories(paths, security);
  assert.equal((await lstat(paths.runtimeRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(socketDirectory)).mode & 0o777, 0o700);

  const linkedHome = await temporaryDirectory(t, 'zipflow-server-linked-');
  const outside = path.join(linkedHome, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, path.join(linkedHome, 'runtime'));
  const linkedPaths = resolveServerPaths({
    zipflowHome: linkedHome,
    socketDirectory: path.join(linkedHome, 'socket'),
  });
  await assert.rejects(
    ensureRuntimeDirectories(linkedPaths, createRuntimeSecurity(linkedPaths)),
    (error) => error?.code === 'RUNTIME_SYMLINK_REJECTED',
  );
});

test('runtime startup narrows a pre-created user-owned ZIPFLOW_HOME to private permissions', async (t) => {
  const home = await temporaryDirectory(t, 'zf-home-');
  await chmod(home, 0o755);
  const paths = resolveServerPaths({
    zipflowHome: home,
    socketDirectory: path.join(home, 'socket'),
  });

  await ensureRuntimeDirectories(paths, createRuntimeSecurity(paths));

  assert.equal((await lstat(home)).mode & 0o777, 0o700);
  assert.equal((await lstat(paths.runtimeRoot)).mode & 0o777, 0o700);
});

test('lifecycle serializes startup and never reclaims a live owner', async (t) => {
  const home = await temporaryDirectory(t, 'zipflow-server-live-');
  const paths = resolveServerPaths({
    zipflowHome: home,
    socketDirectory: path.join(home, 'socket'),
  });
  const owner = lifecycle(paths, { pid: 111, processAlive: async () => true });
  assert.equal((await owner.prepare()).acquired, true);
  await owner.publish({ token: 'owner-token' });

  const contender = lifecycle(paths, {
    pid: 222,
    processAlive: async (pid) => pid === 111,
    probeEndpoint: async () => false,
  });
  await assert.rejects(
    contender.prepare(),
    (error) => error?.code === 'SERVER_RUNTIME_BUSY',
  );
  assert.equal((await lstat(paths.lockPath)).isFile(), true);
  await owner.close();
});

test('lifecycle removes only validated exact stale runtime files', async (t) => {
  const home = await temporaryDirectory(t, 'zipflow-server-stale-');
  const paths = resolveServerPaths({
    zipflowHome: home,
    socketDirectory: path.join(home, 'socket'),
  });
  const stale = lifecycle(paths, { pid: 333, processAlive: async () => false });
  await stale.prepare();
  await stale.publish({ token: 'stale-token' });

  const replacement = lifecycle(paths, {
    pid: 444,
    processAlive: async () => false,
    probeEndpoint: async () => false,
  });
  assert.equal((await replacement.prepare()).acquired, true);
  const published = await replacement.publish({ token: 'replacement-token' });
  assert.equal(published.discovery.pid, 444);
  assert.equal((await lstat(paths.tokenPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(paths.lockPath)).mode & 0o777, 0o600);
  await replacement.close();
  await assert.rejects(lstat(paths.lockPath), { code: 'ENOENT' });
  assert.equal((await lstat(paths.socketDirectory)).isDirectory(), true);
});

test('unbound lifecycle cleanup preserves an endpoint it never owned', async (t) => {
  const home = await temporaryDirectory(t, 'zipflow-server-unbound-');
  const paths = resolveServerPaths({
    zipflowHome: home,
    socketDirectory: path.join(home, 'socket'),
  });
  const lifecycleOwner = lifecycle(paths, { processAlive: async () => true });
  await lifecycleOwner.prepare();
  await lifecycleOwner.publish({ token: 'not-listening' });
  await writeFile(paths.socketPath, 'foreign endpoint', { mode: 0o600 });
  await lifecycleOwner.close();
  assert.equal(await readFile(paths.socketPath, 'utf8'), 'foreign endpoint');
});

function lifecycle(paths, overrides = {}) {
  return new ServerLifecycle({
    paths,
    zipflowVersion: 'test',
    probeEndpoint: async () => false,
    ...overrides,
  });
}

async function temporaryDirectory(t, prefix) {
  const target = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(target, { recursive: true, force: true }));
  return target;
}
