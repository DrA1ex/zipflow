import path from 'node:path';

export const PROJECT_ENVIRONMENT_POLICIES = Object.freeze(['sanitized', 'inherit']);
export const PROJECT_ENVIRONMENT_NOTICE_VERSION = 1;

const SAFE_EXACT_KEYS = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'NO_COLOR', 'FORCE_COLOR',
  'TMPDIR', 'TMP', 'TEMP',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
]);

export function createProjectCommandEnvironment(policy, {
  baseEnv = process.env,
  projectPath = '',
  cwd = projectPath || process.cwd(),
} = {}) {
  if (policy === 'inherit') {
    const env = { ...baseEnv };
    delete env.ZIPFLOW_COMMAND_ENVIRONMENT;
    if (projectPath) env.ZIPFLOW_PROJECT_ROOT = path.resolve(projectPath);
    return env;
  }
  const env = {};
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (value === undefined) continue;
    if (SAFE_EXACT_KEYS.has(key) || key.startsWith('LC_')) env[key] = String(value);
  }
  env.PATH = projectCommandPath(baseEnv?.PATH, { projectPath, cwd });
  if (projectPath) env.ZIPFLOW_PROJECT_ROOT = path.resolve(projectPath);
  env.ZIPFLOW_COMMAND_ENVIRONMENT = 'sanitized';
  return env;
}

export function projectCommandPath(pathValue, { projectPath = '', cwd = '' } = {}) {
  const entries = [];
  const add = (value) => {
    if (!value) return;
    const absolute = path.resolve(value);
    if (!entries.includes(absolute)) entries.push(absolute);
  };
  if (cwd) add(path.join(cwd, 'node_modules', '.bin'));
  if (projectPath && path.resolve(projectPath) !== path.resolve(cwd || projectPath)) {
    add(path.join(projectPath, 'node_modules', '.bin'));
  }
  for (const value of String(pathValue ?? '').split(path.delimiter)) {
    const trimmed = value.trim();
    if (trimmed && path.isAbsolute(trimmed) && !entries.includes(path.normalize(trimmed))) entries.push(path.normalize(trimmed));
  }
  return entries.join(path.delimiter);
}

export function environmentPolicyLabel(value) {
  return value === 'inherit' ? 'Inherit full environment' : 'Sanitized environment';
}
