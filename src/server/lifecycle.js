import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  writeJsonDurableAtomic,
  writeTextDurableAtomic,
} from '../utils/fs.js';
import {
  createRuntimeSecurity,
  ensureRuntimeDirectories,
  resolveServerPaths,
} from './runtime-paths.js';

export class ServerLifecycle {
  constructor({
    paths = resolveServerPaths(),
    security = createRuntimeSecurity(paths),
    apiVersion = '1.0',
    zipflowVersion,
    serverEpoch = randomUUID(),
    pid = process.pid,
    now = () => new Date(),
    processAlive = isProcessAlive,
    probeExisting = null,
    probeEndpoint = probeLocalEndpoint,
  } = {}) {
    if (!zipflowVersion) throw lifecycleError('Zipflow version is required.', 'INVALID_SERVER_CONFIG');
    this.paths = paths;
    this.security = security;
    this.apiVersion = apiVersion;
    this.zipflowVersion = zipflowVersion;
    this.serverEpoch = serverEpoch;
    this.pid = pid;
    this.now = now;
    this.processAlive = processAlive;
    this.probeExisting = probeExisting;
    this.probeEndpoint = probeEndpoint;
    this.lockText = null;
    this.discoveryText = null;
    this.tokenText = null;
    this.published = false;
    this.listening = false;
    this.endpointBound = false;
  }

  async prepare() {
    await ensureRuntimeDirectories(this.paths, this.security);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const lock = {
        version: 1,
        pid: this.pid,
        ownerToken: randomUUID(),
        createdAt: this.now().toISOString(),
      };
      const lockText = jsonText(lock);
      try {
        await this.security.createExclusiveFile(this.paths.lockPath, lockText);
        this.lockText = lockText;
        return { acquired: true, reused: false, lock };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }

      const existing = await this.inspectExisting();
      if (existing.compatible) {
        return {
          acquired: false,
          reused: true,
          discovery: existing.discovery,
          hello: existing.hello ?? null,
        };
      }
      if (!existing.stale) {
        throw lifecycleError(
          'Another Zipflow server owns the runtime endpoint; it was left untouched.',
          'SERVER_RUNTIME_BUSY',
          { discovery: existing.discovery ?? null },
        );
      }
      await this.cleanupStale(existing);
    }
    throw lifecycleError('Could not acquire the Zipflow server runtime lock.', 'SERVER_RUNTIME_BUSY');
  }

  async inspectExisting() {
    const lockText = await this.security.readPrivateFile(this.paths.lockPath);
    const lock = parseJson(lockText);
    if (!validLock(lock)) {
      throw lifecycleError(
        'The existing runtime lock is malformed and cannot be proven stale.',
        'SERVER_RUNTIME_UNVERIFIED',
      );
    }

    const [discoveryText, tokenText] = await Promise.all([
      this.security.readPrivateFile(this.paths.discoveryPath, { optional: true }),
      this.security.readPrivateFile(this.paths.tokenPath, { optional: true }),
    ]);
    const discovery = parseJson(discoveryText);
    if (discoveryText !== null && !validDiscovery(discovery, this.paths, lock)) {
      throw lifecycleError(
        'Existing discovery metadata does not match the validated runtime endpoint.',
        'SERVER_RUNTIME_UNVERIFIED',
      );
    }

    let probe = null;
    if (discovery && tokenText && this.probeExisting) {
      try {
        probe = await this.probeExisting({
          discovery,
          token: tokenText.trim(),
          endpoint: this.paths.endpoint,
        });
      } catch {
        probe = { reachable: false, compatible: false };
      }
    }
    if (probe?.compatible) {
      return {
        compatible: true,
        stale: false,
        lock,
        lockText,
        discovery,
        discoveryText,
        tokenText,
        hello: probe.hello ?? null,
      };
    }

    const alive = await this.processAlive(lock.pid);
    if (alive) {
      return {
        compatible: false,
        stale: false,
        lock,
        lockText,
        discovery,
        discoveryText,
        tokenText,
      };
    }

    const reachable = probe?.reachable ?? await this.probeEndpoint(this.paths.endpoint);
    return {
      compatible: false,
      stale: !reachable,
      lock,
      lockText,
      discovery,
      discoveryText,
      tokenText,
    };
  }

  async cleanupStale(snapshot) {
    if (!snapshot?.stale || !snapshot.lockText) {
      throw lifecycleError('Runtime cleanup requires a validated stale snapshot.', 'SERVER_RUNTIME_UNVERIFIED');
    }
    if (this.paths.endpoint.kind === 'unix') {
      await this.security.removeExact(this.paths.socketPath, { kind: 'socket', optional: true });
    }
    if (snapshot.discoveryText !== null) {
      await this.security.removeExact(this.paths.discoveryPath, {
        kind: 'file',
        expectedText: snapshot.discoveryText,
      });
    }
    if (snapshot.tokenText !== null) {
      await this.security.removeExact(this.paths.tokenPath, {
        kind: 'file',
        expectedText: snapshot.tokenText,
      });
    }
    await this.security.removeExact(this.paths.lockPath, {
      kind: 'file',
      expectedText: snapshot.lockText,
    });
  }

  async publish({ token = createServerToken(), startedAt = this.now().toISOString() } = {}) {
    this.assertOwned();
    if (!token || typeof token !== 'string') throw lifecycleError('A server token is required.', 'INVALID_SERVER_CONFIG');
    const discovery = {
      pid: this.pid,
      socketPath: this.paths.socketPath,
      apiVersion: this.apiVersion,
      zipflowVersion: this.zipflowVersion,
      serverEpoch: this.serverEpoch,
      startedAt,
    };
    this.tokenText = `${token}\n`;
    this.discoveryText = jsonText(discovery);
    await writeTextDurableAtomic(this.paths.tokenPath, this.tokenText);
    await this.security.assertPrivateFile(this.paths.tokenPath);
    await writeJsonDurableAtomic(this.paths.discoveryPath, discovery);
    await this.security.assertPrivateFile(this.paths.discoveryPath);
    this.published = true;
    return { discovery, token };
  }

  async markListening() {
    this.assertOwned();
    this.endpointBound = true;
    if (this.paths.endpoint.kind === 'unix') await this.security.secureSocket(this.paths.socketPath);
    this.listening = true;
  }

  async close() {
    if (!this.lockText) return;
    const currentLock = await this.security.readPrivateFile(this.paths.lockPath, { optional: true });
    if (currentLock !== this.lockText) {
      this.clearOwnership();
      if (currentLock === null) return;
      throw lifecycleError(
        'Runtime ownership changed; shutdown cleanup was refused.',
        'SERVER_RUNTIME_OWNERSHIP_LOST',
      );
    }
    if (this.endpointBound && this.paths.endpoint.kind === 'unix') {
      await this.security.removeExact(this.paths.socketPath, { kind: 'socket', optional: true });
    }
    if (this.discoveryText !== null) {
      await this.security.removeExact(this.paths.discoveryPath, {
        kind: 'file',
        optional: true,
        expectedText: this.discoveryText,
      });
    }
    if (this.tokenText !== null) {
      await this.security.removeExact(this.paths.tokenPath, {
        kind: 'file',
        optional: true,
        expectedText: this.tokenText,
      });
    }
    await this.security.removeExact(this.paths.lockPath, {
      kind: 'file',
      expectedText: this.lockText,
    });
    this.clearOwnership();
  }

  assertOwned() {
    if (!this.lockText) throw lifecycleError('The server runtime lock is not owned.', 'SERVER_RUNTIME_NOT_OWNED');
  }

  clearOwnership() {
    this.lockText = null;
    this.discoveryText = null;
    this.tokenText = null;
    this.published = false;
    this.listening = false;
    this.endpointBound = false;
  }
}

export function createServerToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export async function probeLocalEndpoint(endpoint, { timeoutMs = 150 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint.listenPath);
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function validLock(value) {
  return value?.version === 1
    && Number.isInteger(value.pid)
    && value.pid > 0
    && typeof value.ownerToken === 'string'
    && value.ownerToken.length > 0
    && Number.isFinite(Date.parse(value.createdAt));
}

function validDiscovery(value, paths, lock) {
  return value
    && value.pid === lock.pid
    && value.socketPath === paths.socketPath
    && typeof value.apiVersion === 'string'
    && typeof value.zipflowVersion === 'string'
    && typeof value.serverEpoch === 'string'
    && Number.isFinite(Date.parse(value.startedAt));
}

function parseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function lifecycleError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}
