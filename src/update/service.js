import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../utils/process.js';
import { ZIPFLOW_VERSION } from '../version.js';

export const ZIPFLOW_PACKAGE_NAME = 'zipflow';
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function createUpdateService(options = {}) {
  return {
    check: (overrides = {}) => checkForUpdate({ ...options, ...overrides }),
    install: (version, overrides = {}) => installUpdate(version, { ...options, ...overrides }),
  };
}

export async function checkForUpdate({
  currentVersion = ZIPFLOW_VERSION,
  packageName = ZIPFLOW_PACKAGE_NAME,
  registry = NPM_REGISTRY,
  run = runProcess,
  detectInstallation = detectNpmGlobalInstallation,
  timeoutMs = 6_000,
  allowUnsupportedInstallation = false,
} = {}) {
  const installation = await detectInstallation({ packageName, run, timeoutMs: Math.min(timeoutMs, 3_000) });
  if (installation.mode !== 'global-npm' && !allowUnsupportedInstallation) {
    return { status: 'unsupported', currentVersion, installation };
  }

  const result = await run('npm', [
    'view', `${packageName}@latest`, 'version', '--json',
    `--registry=${registry}`,
    '--fetch-retries=0',
    `--fetch-timeout=${Math.max(1_000, timeoutMs)}`,
    '--silent',
  ], {
    timeoutMs,
    env: npmEnvironment(),
  });

  if (!result.ok) {
    return {
      status: 'unavailable', currentVersion, installation,
      error: updateCommandError('Could not read the latest npm version.', result),
    };
  }

  const latestVersion = parseNpmVersion(result.stdout);
  if (!latestVersion || !parseVersion(currentVersion)) {
    return {
      status: 'unavailable', currentVersion, installation,
      error: new Error('npm returned an invalid Zipflow version.'),
    };
  }

  return compareVersions(latestVersion, currentVersion) > 0
    ? { status: 'available', currentVersion, latestVersion, installation, installSupported: installation.mode === 'global-npm' }
    : { status: 'current', currentVersion, latestVersion, installation, installSupported: installation.mode === 'global-npm' };
}

export async function installUpdate(version, {
  packageName = ZIPFLOW_PACKAGE_NAME,
  registry = NPM_REGISTRY,
  run = runProcess,
  timeoutMs = 10 * 60_000,
  signal = null,
  onOutput = null,
} = {}) {
  const normalized = normalizeVersion(version);
  if (!normalized) throw new Error(`Invalid Zipflow update version: ${version}`);
  const args = [
    'install', '-g', `${packageName}@${normalized}`,
    `--registry=${registry}`,
    '--no-audit', '--no-fund', '--silent',
  ];
  const result = await run('npm', args, {
    timeoutMs,
    signal,
    onOutput,
    env: npmEnvironment(),
  });
  if (!result.ok) throw updateCommandError(`npm could not install Zipflow ${normalized}.`, result);
  return {
    version: normalized,
    command: formatInstallCommand(normalized, { packageName, registry }),
    result,
  };
}

export async function detectNpmGlobalInstallation({
  packageName = ZIPFLOW_PACKAGE_NAME,
  packageRoot = PACKAGE_ROOT,
  run = runProcess,
  timeoutMs = 3_000,
} = {}) {
  const result = await run('npm', ['root', '-g', '--silent'], {
    timeoutMs,
    env: npmEnvironment(),
  });
  if (!result.ok) return { mode: 'unknown', packageRoot };
  const globalRoot = String(result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!globalRoot) return { mode: 'unknown', packageRoot };
  const installedPath = path.join(globalRoot, packageName);
  let stats;
  try { stats = await lstat(installedPath); } catch { return { mode: 'local', packageRoot, globalRoot, installedPath }; }
  if (stats.isSymbolicLink()) return { mode: 'linked', packageRoot, globalRoot, installedPath };
  try {
    const [currentRealPath, installedRealPath] = await Promise.all([realpath(packageRoot), realpath(installedPath)]);
    return {
      mode: currentRealPath === installedRealPath ? 'global-npm' : 'local',
      packageRoot: currentRealPath,
      globalRoot,
      installedPath: installedRealPath,
    };
  } catch {
    return { mode: 'unknown', packageRoot, globalRoot, installedPath };
  }
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Cannot compare invalid versions: ${left}, ${right}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumber = /^\d+$/.test(aPart) ? Number(aPart) : null;
    const bNumber = /^\d+$/.test(bPart) ? Number(bPart) : null;
    if (aNumber !== null && bNumber !== null) return aNumber > bNumber ? 1 : -1;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return aPart.localeCompare(bPart);
  }
  return 0;
}

export function parseVersion(value) {
  const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function formatInstallCommand(version, {
  packageName = ZIPFLOW_PACKAGE_NAME,
  registry = NPM_REGISTRY,
} = {}) {
  return `npm install -g ${packageName}@${normalizeVersion(version)} --registry=${registry}`;
}

function parseNpmVersion(stdout) {
  const source = String(stdout ?? '').trim();
  if (!source) return null;
  try {
    const parsed = JSON.parse(source);
    if (typeof parsed === 'string') return normalizeVersion(parsed);
    if (Array.isArray(parsed) && typeof parsed.at(-1) === 'string') return normalizeVersion(parsed.at(-1));
  } catch {}
  return normalizeVersion(source.split(/\r?\n/).filter(Boolean).at(-1));
}

function normalizeVersion(value) {
  const source = String(value ?? '').trim().replace(/^v/, '');
  return parseVersion(source) ? source : '';
}

function npmEnvironment() {
  return {
    NO_UPDATE_NOTIFIER: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
  };
}

function updateCommandError(message, result) {
  const detail = String(result?.stderr || result?.stdout || '').trim();
  const error = new Error(detail ? `${message} ${detail}` : message);
  error.code = result?.timedOut ? 'update-timeout' : 'update-command-failed';
  error.exitCode = result?.code;
  error.commandResult = result;
  return error;
}
