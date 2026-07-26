import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
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
    verify: (verification, overrides = {}) => verifyInstalledUpdate(verification, { ...options, ...overrides }),
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
  resolveBinary = null,
} = {}) {
  const installation = await detectInstallation({ packageName, run, timeoutMs: Math.min(timeoutMs, 3_000), resolveBinary });
  if (installation.mode !== 'global-npm' && !allowUnsupportedInstallation) {
    return { status: 'unsupported', currentVersion, installation };
  }

  const npm = await resolveUpdateBinary('npm', { run, resolveBinary });
  const result = await run(npm, [
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
  resolveBinary = null,
} = {}) {
  const normalized = normalizeVersion(version);
  if (!normalized) throw new Error(`Invalid Zipflow update version: ${version}`);
  const args = [
    'install', '-g', `${packageName}@${normalized}`,
    `--registry=${registry}`,
    '--no-audit', '--no-fund', '--silent',
  ];
  const npm = await resolveUpdateBinary('npm', { run, resolveBinary });
  const result = await run(npm, args, {
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


export async function verifyInstalledUpdate({
  previousVersion,
  targetVersion,
  installation = null,
} = {}, {
  packageName = ZIPFLOW_PACKAGE_NAME,
  run = runProcess,
  detectInstallation = detectNpmGlobalInstallation,
  timeoutMs = 6_000,
  nodePath = process.execPath,
  resolveBinary = null,
} = {}) {
  const previous = normalizeVersion(previousVersion);
  const target = normalizeVersion(targetVersion);
  if (!target) throw new Error(`Invalid Zipflow verification target: ${targetVersion}`);
  const detected = installation?.installedPath
    ? installation
    : await detectInstallation({ packageName, run, timeoutMs: Math.min(timeoutMs, 3_000), resolveBinary });
  const installedPath = detected?.installedPath;
  if (!installedPath) {
    return uncertainVerification({ previous, target, installation: detected }, 'The global Zipflow package path could not be resolved.');
  }

  let packageMetadata;
  try {
    packageMetadata = JSON.parse(await readFile(path.join(installedPath, 'package.json'), 'utf8'));
  } catch (error) {
    return uncertainVerification({ previous, target, installation: detected, installedPath }, `The installed package metadata is unavailable: ${error.message}`);
  }
  const packageVersion = normalizeVersion(packageMetadata.version);
  const relativeBin = packageExecutable(packageMetadata.bin, packageName);
  if (!relativeBin) {
    return uncertainVerification({ previous, target, installation: detected, installedPath, packageVersion }, 'The installed package does not define a Zipflow executable.');
  }
  const executablePath = path.resolve(installedPath, relativeBin);
  if (!pathInside(installedPath, executablePath)) {
    return uncertainVerification({ previous, target, installation: detected, installedPath, packageVersion, executablePath }, 'The installed package executable points outside the Zipflow package directory.');
  }
  try {
    const executableStats = await lstat(executablePath);
    if (!executableStats.isFile() || executableStats.isSymbolicLink()) throw new Error('not a regular package file');
    const [packageRealPath, executableRealPath] = await Promise.all([realpath(installedPath), realpath(executablePath)]);
    if (!pathInside(packageRealPath, executableRealPath)) throw new Error('resolves outside the package directory');
  } catch (error) {
    return uncertainVerification({ previous, target, installation: detected, installedPath, packageVersion, executablePath }, `The installed Zipflow executable is unavailable: ${error.message}`);
  }

  const probe = await run(nodePath, [executablePath, '--version'], {
    timeoutMs,
    inheritEnv: false,
    env: updateProbeEnvironment(),
  }).catch((error) => ({ ok: false, stderr: error.message, error }));
  const probeVersion = probe?.ok
    ? normalizeVersion(String(probe.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1))
    : '';
  const base = {
    previousVersion: previous || null,
    targetVersion: target,
    packageVersion: packageVersion || null,
    probeVersion: probeVersion || null,
    executablePath,
    executableExists: true,
    installation: detected,
    probe,
  };
  if (packageVersion === target && probeVersion === target) return { ...base, status: 'updated' };
  if (previous && packageVersion === previous && probeVersion === previous) return { ...base, status: 'unchanged' };
  const detail = !probe?.ok
    ? `The installed executable probe failed: ${String(probe?.stderr || probe?.stdout || 'unknown error').trim()}`
    : `Installed package version ${packageVersion || 'unknown'} and executable version ${probeVersion || 'unknown'} do not agree with the expected state.`;
  return { ...base, status: 'uncertain', detail };
}

export async function detectNpmGlobalInstallation({
  packageName = ZIPFLOW_PACKAGE_NAME,
  packageRoot = PACKAGE_ROOT,
  run = runProcess,
  timeoutMs = 3_000,
  resolveBinary = null,
} = {}) {
  const npm = await resolveUpdateBinary('npm', { run, resolveBinary });
  const result = await run(npm, ['root', '-g', '--silent'], {
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
    const comparison = compareNumericIdentifier(a[key], b[key]);
    if (comparison) return comparison;
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
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) return compareNumericIdentifier(aPart, bPart);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

export function parseVersion(value) {
  const source = String(value ?? '').trim();
  const match = source.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return null;
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
    build: match[5] ? match[5].split('.') : [],
  };
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
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


function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function packageExecutable(bin, packageName) {
  if (typeof bin === 'string') return bin;
  if (!bin || typeof bin !== 'object') return '';
  if (typeof bin[packageName] === 'string') return bin[packageName];
  return Object.values(bin).find((value) => typeof value === 'string') ?? '';
}

function uncertainVerification(base, detail) {
  return {
    previousVersion: base.previous || null,
    targetVersion: base.target,
    packageVersion: base.packageVersion || null,
    probeVersion: null,
    executablePath: base.executablePath || null,
    executableExists: false,
    installedPath: base.installedPath || null,
    installation: base.installation ?? null,
    status: 'uncertain',
    detail,
  };
}

function updateProbeEnvironment() {
  return {
    HOME: process.env.HOME ?? '',
    USERPROFILE: process.env.USERPROFILE ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    TMP: process.env.TMP ?? '',
    TEMP: process.env.TEMP ?? '',
    LANG: process.env.LANG ?? 'C',
    LC_ALL: process.env.LC_ALL ?? '',
  };
}

async function resolveUpdateBinary(toolId, { run, resolveBinary }) {
  if (typeof resolveBinary === 'function') return resolveBinary(toolId);
  if (run !== runProcess) return toolId;
  const { resolveInternalBinary } = await import('../security/binaries.js');
  return resolveInternalBinary(toolId);
}
