import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipflowClient } from '../src/client/index.js';
import {
  createServeServerOptions,
  parseServeArguments,
} from '../src/server/serve-command.js';
import { resolveServerPaths } from '../src/server/runtime-paths.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const executable = path.join(projectRoot, 'bin', 'zipflow.js');

test('serve arguments validate endpoint and idle-timeout values without platform assumptions', () => {
  assert.deepEqual(parseServeArguments([]), { socketPath: null, idleTimeoutMs: 0 });
  assert.deepEqual(parseServeArguments([
    '--idle-timeout-ms=300000',
    '--socket',
    '/tmp/zipflow-cli.sock',
  ]), {
    socketPath: '/tmp/zipflow-cli.sock',
    idleTimeoutMs: 300000,
  });
  assert.throws(() => parseServeArguments(['--idle-timeout-ms', '-1']), { code: 'INVALID_SERVE_ARGUMENT' });
  assert.throws(() => parseServeArguments(['--idle-timeout-ms', '1.5']), { code: 'INVALID_SERVE_ARGUMENT' });
  assert.throws(() => parseServeArguments(['--socket']), { code: 'INVALID_SERVE_ARGUMENT' });
  assert.throws(() => parseServeArguments(['--unknown']), { code: 'INVALID_SERVE_ARGUMENT' });

  const pipePath = '\\\\.\\pipe\\zipflow-cli-test';
  const windows = createServeServerOptions(parseServeArguments(['--socket', pipePath]), {
    platform: 'win32',
    zipflowHome: os.tmpdir(),
  });
  assert.equal(windows.paths.endpoint.kind, 'named-pipe');
  assert.equal(windows.paths.endpoint.listenPath, pipePath);
});

test('zipflow serve publishes discovery, answers hello, and cleans exact runtime state on SIGTERM', {
  skip: process.platform === 'win32' ? 'Windows runtime security remains fail-closed.' : false,
}, async (t) => {
  const fixture = await spawnServe(t, { idleTimeoutMs: 0 });
  const ready = await waitForReady(fixture);
  assert.equal(ready.discovery.pid, fixture.child.pid);
  assert.equal(ready.discovery.socketPath, fixture.socketPath);
  assert.equal(ready.hello.serverEpoch, ready.discovery.serverEpoch);
  assert.equal(ready.hello.server.version, ready.discovery.zipflowVersion);

  assert.equal(fixture.child.kill('SIGTERM'), true);
  const exit = await waitForExit(fixture.child);
  assert.deepEqual(exit, { code: 0, signal: null });
  await assertRuntimeRemoved(fixture.paths);
});

test('a second zipflow serve reuses the live owner without signaling it', {
  skip: process.platform === 'win32' ? 'Windows runtime security remains fail-closed.' : false,
}, async (t) => {
  const fixture = await spawnServe(t, { idleTimeoutMs: 0 });
  const ready = await waitForReady(fixture);
  const contender = spawnServeProcess({
    home: fixture.home,
    socketPath: fixture.socketPath,
    idleTimeoutMs: 0,
  });
  const contenderOutput = collectOutput(contender);
  t.after(async () => {
    if (contender.exitCode === null && contender.signalCode === null) {
      contender.kill('SIGKILL');
      await waitForExit(contender).catch(() => {});
    }
  });

  const contenderExit = await waitForExit(contender);
  assert.deepEqual(contenderExit, { code: 0, signal: null }, contenderOutput());
  assert.equal(fixture.child.exitCode, null);
  const hello = await new ZipflowClient({
    socketPath: fixture.socketPath,
    token: ready.token,
  }).hello();
  assert.equal(hello.serverEpoch, ready.hello.serverEpoch);

  assert.equal(fixture.child.kill('SIGINT'), true);
  const ownerExit = await waitForExit(fixture.child);
  assert.deepEqual(ownerExit, { code: 0, signal: null });
  await assertRuntimeRemoved(fixture.paths);
});

test('zipflow serve idle timeout closes the foreground process and cleans runtime state', {
  skip: process.platform === 'win32' ? 'Windows runtime security remains fail-closed.' : false,
}, async (t) => {
  const fixture = await spawnServe(t, { idleTimeoutMs: 400 });
  await waitForReady(fixture);
  const exit = await waitForExit(fixture.child, 5_000);
  assert.deepEqual(exit, { code: 0, signal: null });
  await assertRuntimeRemoved(fixture.paths);
});

async function spawnServe(t, { idleTimeoutMs }) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'zipflow-serve-cli-'));
  const socketPath = path.join(home, 'endpoint', 'serve.sock');
  const paths = resolveServerPaths({ zipflowHome: home, socketPath });
  const child = spawnServeProcess({ home, socketPath, idleTimeoutMs });
  const output = collectOutput(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child).catch(() => {});
    }
    await rm(home, { recursive: true, force: true });
  });
  return { home, socketPath, paths, child, output };
}

function spawnServeProcess({ home, socketPath, idleTimeoutMs }) {
  return spawn(process.execPath, [
    executable,
    'serve',
    '--socket',
    socketPath,
    '--idle-timeout-ms',
    String(idleTimeoutMs),
  ], {
    cwd: projectRoot,
    env: { ...process.env, ZIPFLOW_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForReady(fixture, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) {
      throw new Error(`zipflow serve exited before discovery: ${fixture.output()}`);
    }
    try {
      const [discoverySource, tokenSource] = await Promise.all([
        readFile(fixture.paths.discoveryPath, 'utf8'),
        readFile(fixture.paths.tokenPath, 'utf8'),
      ]);
      const discovery = JSON.parse(discoverySource);
      const token = tokenSource.trim();
      const client = new ZipflowClient({ socketPath: fixture.socketPath, token, timeoutMs: 250 });
      const hello = await client.hello();
      return { discovery, token, hello };
    } catch (error) {
      lastError = error;
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for zipflow serve: ${lastError?.message ?? 'not ready'}; ${fixture.output()}`);
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Timed out waiting for zipflow serve to exit.'));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function assertRuntimeRemoved(paths) {
  for (const target of [
    paths.socketPath,
    paths.discoveryPath,
    paths.tokenPath,
    paths.lockPath,
  ]) {
    await assert.rejects(access(target), { code: 'ENOENT' });
  }
}

function collectOutput(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', (error) => { stderr += error.stack ?? error.message; });
  return () => `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
