import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { getZipflowHome } from '../workflow/store.js';

const SERVICE = 'zipflow.local-llm';
const testVault = new Map();
let backendOverride = null;
let resolvedSecretToolPath = null;

export class SecureCredentialStoreError extends Error {
  constructor(message, { code = 'credential-store-error', cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SecureCredentialStoreError';
    this.code = code;
  }
}

export async function readLlmApiToken() {
  const value = await credentialBackend().read(identity());
  return typeof value === 'string' ? value : '';
}

export async function writeLlmApiToken(token) {
  const value = String(token ?? '');
  if (!value) return deleteLlmApiToken();
  await credentialBackend().write(identity(), value);
}

export async function deleteLlmApiToken() {
  await credentialBackend().delete(identity());
}

export function setCredentialBackendForTests(backend) {
  backendOverride = backend;
}

export function resetCredentialBackendForTests() {
  backendOverride = null;
  resolvedSecretToolPath = null;
  testVault.clear();
}

function identity() {
  return {
    service: SERVICE,
    account: `home-${createHash('sha256').update(getZipflowHome()).digest('hex').slice(0, 24)}`,
  };
}

function credentialBackend() {
  if (backendOverride) return backendOverride;
  if (process.env.NODE_TEST_CONTEXT) return memoryBackend();
  if (process.platform === 'darwin') return macosBackend();
  if (process.platform === 'linux') return linuxBackend();
  throw unavailable(`Secure credential storage is not supported on ${process.platform}.`);
}

function memoryBackend() {
  return {
    async read({ service, account }) {
      return testVault.get(`${service}:${account}`) ?? '';
    },
    async write({ service, account }, value) {
      testVault.set(`${service}:${account}`, value);
    },
    async delete({ service, account }) {
      testVault.delete(`${service}:${account}`);
    },
  };
}

function macosBackend() {
  return {
    async read({ service, account }) {
      const result = await run('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service, '-w'], { allowMissingItem: true });
      return stripFinalNewline(result.stdout);
    },
    async write({ service, account }, value) {
      await run('/usr/bin/security', ['add-generic-password', '-a', account, '-s', service, '-U', '-w', value]);
    },
    async delete({ service, account }) {
      await run('/usr/bin/security', ['delete-generic-password', '-a', account, '-s', service], { allowMissingItem: true });
    },
  };
}

function linuxBackend() {
  const unavailableMessage = 'Secure credential storage is unavailable. Install secret-tool and run a Secret Service-compatible keyring. The token was not written to disk.';
  return {
    async read({ service, account }) {
      const result = await run(await secretToolPath(), ['lookup', 'service', service, 'account', account], {
        allowMissingItem: true,
        unavailableMessage,
      });
      return stripFinalNewline(result.stdout);
    },
    async write({ service, account }, value) {
      await run(await secretToolPath(), ['store', '--label=Zipflow local LLM credential', 'service', service, 'account', account], {
        input: value,
        unavailableMessage,
      });
    },
    async delete({ service, account }) {
      await run(await secretToolPath(), ['clear', 'service', service, 'account', account], {
        allowMissingItem: true,
        unavailableMessage,
      });
    },
  };
}


async function secretToolPath() {
  if (resolvedSecretToolPath) return resolvedSecretToolPath;
  const candidates = ['/usr/bin/secret-tool', '/bin/secret-tool', '/usr/local/bin/secret-tool'];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const resolved = await realpath(candidate);
      if (!await isTrustedSystemExecutable(resolved)) continue;
      resolvedSecretToolPath = resolved;
      return resolved;
    } catch {}
  }
  throw unavailable('Secure credential storage is unavailable. Install secret-tool in a standard system location and run a Secret Service-compatible keyring. The token was not written to disk.');
}

async function isTrustedSystemExecutable(target) {
  const executable = await stat(target);
  if (!executable.isFile() || executable.uid !== 0 || (executable.mode & 0o022)) return false;
  let directory = path.dirname(target);
  while (true) {
    const record = await stat(directory);
    if (!record.isDirectory() || record.uid !== 0 || (record.mode & 0o022)) return false;
    const parent = path.dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}

function run(command, args, { input = null, allowMissingItem = false, unavailableMessage = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(unavailable(unavailableMessage || 'Secure credential storage is unavailable. The token was not written to disk.', error));
        return;
      }
      if (unavailableMessage) {
        reject(unavailable(unavailableMessage, error));
        return;
      }
      reject(new SecureCredentialStoreError('Secure credential storage could not be accessed.', { cause: error }));
    });
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const diagnostic = Buffer.concat(stderr).toString('utf8').trim().slice(0, 1000);
      if (code === 0) {
        resolve({ stdout: output, stderr: diagnostic });
        return;
      }
      if (allowMissingItem && isMissingItemResult(code, diagnostic)) {
        resolve({ stdout: '', stderr: diagnostic });
        return;
      }
      if (unavailableMessage) {
        reject(unavailable(diagnostic ? `${unavailableMessage} (${diagnostic})` : unavailableMessage));
        return;
      }
      reject(new SecureCredentialStoreError(
        diagnostic
          ? `Secure credential storage rejected the request: ${diagnostic}`
          : 'Secure credential storage rejected the request.',
      ));
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function isMissingItemResult(code, diagnostic) {
  if (process.platform === 'darwin') return code === 44 || /could not be found/i.test(diagnostic);
  return code === 1 && !diagnostic;
}

function stripFinalNewline(value) {
  return String(value ?? '').replace(/(?:\r?\n)+$/, '');
}

function unavailable(message, cause = null) {
  return new SecureCredentialStoreError(message, { code: 'credential-store-unavailable', cause });
}
