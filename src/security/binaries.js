import path from 'node:path';
import process from 'node:process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { runProcess } from '../utils/process.js';
import { loadSettings } from '../settings/store.js';

export const BINARY_TOOL_IDS = Object.freeze(['git', 'npm', 'node', 'opener', 'python', 'gofmt', 'codex']);

const DEFINITIONS = Object.freeze({
  git: {
    label: 'Git', candidates: ['git'], probeArgs: ['--version'],
    probePattern: /^git version\s+/i,
  },
  npm: {
    label: 'npm', candidates: ['npm'], probeArgs: ['--version'],
    probePattern: /^\d+\.\d+/,
  },
  node: {
    label: 'Node.js', candidates: ['node'], processExecutable: true, probeArgs: ['--version'],
    probePattern: /^v\d+\.\d+/,
  },
  opener: {
    label: 'System opener', candidates: process.platform === 'darwin' ? ['open'] : ['xdg-open'],
  },
  python: {
    label: 'Python', candidates: ['python3', 'python'], probeArgs: ['--version'],
    probePattern: /^Python\s+\d+\.\d+/i,
  },
  gofmt: {
    label: 'Go formatter', candidates: ['gofmt'],
  },
  codex: {
    label: 'Codex CLI', candidates: ['codex'], probeArgs: ['--version'],
    probePattern: /codex/i,
  },
});

const resolutionCache = new Map();

export function binaryDefinition(toolId) {
  const definition = DEFINITIONS[toolId];
  if (!definition) throw new Error(`Unknown internal binary: ${toolId}`);
  return { id: toolId, ...definition };
}

export function configuredBinaryPath(settings, toolId) {
  const value = settings?.binaryPaths?.[toolId];
  return typeof value === 'string' ? value.trim() : '';
}

export async function inspectBinary(toolId, {
  settings = null,
  env = process.env,
  run = runProcess,
  cwd = process.cwd(),
  refresh = false,
} = {}) {
  const definition = binaryDefinition(toolId);
  const activeSettings = settings ?? await loadSettings();
  const configuredPath = configuredBinaryPath(activeSettings, toolId);
  const cacheKey = JSON.stringify([toolId, configuredPath, env.PATH ?? '', path.resolve(cwd), process.platform]);
  if (!refresh && resolutionCache.has(cacheKey)) return resolutionCache.get(cacheKey);

  const promise = inspectBinaryUncached(definition, { configuredPath, env, run, cwd });
  resolutionCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    resolutionCache.delete(cacheKey);
    throw error;
  }
}

export async function inspectAllBinaries(options = {}) {
  const settings = options.settings ?? await loadSettings();
  const entries = await Promise.all(BINARY_TOOL_IDS.map(async (toolId) => [
    toolId,
    await inspectBinary(toolId, { ...options, settings }).catch((error) => ({
      toolId,
      label: binaryDefinition(toolId).label,
      configuredPath: configuredBinaryPath(settings, toolId),
      resolvedPath: '',
      mode: configuredBinaryPath(settings, toolId) ? 'manual' : 'automatic',
      valid: false,
      status: 'invalid',
      version: '',
      error: error.message,
    })),
  ]));
  return Object.fromEntries(entries);
}

export async function resolveInternalBinary(toolId, options = {}) {
  const status = await inspectBinary(toolId, options);
  if (!status.valid || !status.resolvedPath) {
    const error = new Error(status.error || `${status.label} executable was not found.`);
    error.code = 'binary-unavailable';
    error.toolId = toolId;
    error.binaryStatus = status;
    throw error;
  }
  return status.resolvedPath;
}

export async function validateBinaryPath(toolId, entered, {
  run = runProcess,
  probe = true,
} = {}) {
  const definition = binaryDefinition(toolId);
  const candidate = String(entered ?? '').trim();
  if (!candidate) throw new Error(`Choose an absolute path for ${definition.label}.`);
  const validated = await validateExecutable(candidate);
  const probeResult = probe ? await probeBinary(definition, validated.realPath, run) : { version: '' };
  const warning = manualOverrideWarning(validated.realPath);
  return {
    toolId,
    label: definition.label,
    configuredPath: validated.realPath,
    resolvedPath: validated.realPath,
    mode: 'manual',
    valid: true,
    status: 'valid',
    version: probeResult.version,
    error: '',
    warning,
    excludedPaths: [],
  };
}

export async function detectBinary(toolId, {
  env = process.env,
  run = runProcess,
  cwd = process.cwd(),
  probe = true,
} = {}) {
  const definition = binaryDefinition(toolId);
  const detection = await detectExecutable(definition, env, { cwd });
  const detected = detection.path;
  if (!detected) {
    return {
      toolId,
      label: definition.label,
      configuredPath: '',
      resolvedPath: '',
      mode: 'automatic',
      valid: false,
      status: 'missing',
      version: '',
      error: `${definition.label} executable was not found in automatic search paths.`,
      warning: '',
      excludedPaths: detection.excluded,
    };
  }
  try {
    const validated = await validateExecutable(detected);
    const probeResult = probe ? await probeBinary(definition, validated.realPath, run) : { version: '' };
    return {
      toolId,
      label: definition.label,
      configuredPath: '',
      resolvedPath: validated.realPath,
      mode: 'automatic',
      valid: true,
      status: 'valid',
      version: probeResult.version,
      error: '',
      warning: '',
      excludedPaths: detection.excluded,
    };
  } catch (error) {
    return {
      toolId,
      label: definition.label,
      configuredPath: '',
      resolvedPath: detected,
      mode: 'automatic',
      valid: false,
      status: 'invalid',
      version: '',
      error: error.message,
      warning: '',
      excludedPaths: detection.excluded,
    };
  }
}

export function clearBinaryResolutionCache() {
  resolutionCache.clear();
}

async function inspectBinaryUncached(definition, { configuredPath, env, run, cwd }) {
  if (configuredPath) {
    try {
      return await validateBinaryPath(definition.id, configuredPath, { run, probe: true });
    } catch (error) {
      return {
        toolId: definition.id,
        label: definition.label,
        configuredPath,
        resolvedPath: configuredPath,
        mode: 'manual',
        valid: false,
        status: 'invalid',
        version: '',
        error: error.message,
      };
    }
  }
  return detectBinary(definition.id, { env, run, cwd, probe: true });
}

async function detectExecutable(definition, env, { cwd }) {
  if (definition.processExecutable && path.isAbsolute(process.execPath)) {
    return { path: (await validateExecutable(process.execPath, { automatic: true, cwd })).realPath, excluded: [] };
  }
  const { directories, excluded } = inspectPathDirectories(env.PATH, { cwd });
  for (const directory of directories) {
    for (const name of definition.candidates) {
      const candidate = path.join(directory, name);
      try {
        return { path: (await validateExecutable(candidate, { automatic: true, cwd })).realPath, excluded };
      } catch {}
    }
  }
  return { path: null, excluded };
}

export function trustedPathDirectories(pathValue, { cwd = '' } = {}) {
  return inspectPathDirectories(pathValue, { cwd }).directories;
}

export function inspectPathDirectories(pathValue, { cwd = '' } = {}) {
  const directories = [];
  const excluded = [];
  const seen = new Set();
  for (const value of String(pathValue ?? '').split(path.delimiter)) {
    const directory = value.trim();
    if (!directory || !path.isAbsolute(directory)) continue;
    const normalized = path.normalize(directory);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    let reason = '';
    if (isProjectLocalBinaryDirectory(normalized)) reason = 'project node_modules/.bin';
    else if (isInsideRoot(normalized, cwd)) reason = 'inside the current project';
    if (reason) excluded.push({ path: normalized, reason });
    else directories.push(normalized);
  }
  return { directories, excluded };
}

function isProjectLocalBinaryDirectory(directory) {
  const normalized = directory.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
  return normalized.endsWith('/node_modules/.bin') || normalized.includes('/node_modules/.bin/');
}

function isInsideRoot(candidate, root) {
  if (!root) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function validateExecutable(candidate, { automatic = false, cwd = '' } = {}) {
  if (!path.isAbsolute(candidate)) throw new Error('Binary path must be absolute.');
  let info;
  try {
    info = await lstat(candidate);
  } catch {
    throw new Error(`Binary does not exist: ${candidate}`);
  }
  if (info.isDirectory()) throw new Error(`Binary path points to a directory: ${candidate}`);
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new Error(`Binary real path could not be resolved: ${candidate}`);
  }
  const resolvedInfo = await lstat(resolved);
  if (!resolvedInfo.isFile()) throw new Error(`Binary path is not a regular file: ${resolved}`);
  const resolvedDirectory = path.dirname(resolved);
  if (automatic && isInsideRoot(resolvedDirectory, cwd)) {
    throw new Error('Project-local executables cannot be selected automatically for internal Zipflow operations.');
  }
  try {
    await access(resolved, fsConstants.X_OK);
  } catch {
    throw new Error(`Binary is not executable: ${resolved}`);
  }
  return { realPath: resolved };
}

function manualOverrideWarning(executable) {
  const directory = path.dirname(executable);
  if (isProjectLocalBinaryDirectory(directory)) {
    return 'Manual override: this executable is inside node_modules/.bin and bypasses automatic project-local exclusion.';
  }
  return '';
}

async function probeBinary(definition, executable, run) {
  if (!definition.probeArgs) return { version: '' };
  const result = await run(executable, definition.probeArgs, {
    timeoutMs: 10_000,
    env: probeEnvironment(executable),
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (!result.ok || definition.probePattern && !definition.probePattern.test(output)) {
    const detail = output.split(/\r?\n/).find(Boolean) || `exit code ${result.code}`;
    throw new Error(`${definition.label} probe failed: ${detail}`);
  }
  return { version: output.split(/\r?\n/).find(Boolean) ?? '' };
}

function probeEnvironment(executable) {
  const pathEntries = [path.dirname(executable), path.dirname(process.execPath), ...trustedPathDirectories(process.env.PATH)];
  return {
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    PATH: [...new Set(pathEntries)].join(path.delimiter),
    NO_UPDATE_NOTIFIER: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
  };
}
