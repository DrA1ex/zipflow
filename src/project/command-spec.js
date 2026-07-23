import path from 'node:path';
import { stat } from 'node:fs/promises';
import { assertSafeProjectPath, normalizeRelative } from '../security/project-path.js';

export const COMMAND_DIRECTORY_SEPARATOR = '::';

export function parseCommandSpec(value) {
  const raw = String(value ?? '').trim();
  const separatorIndex = raw.indexOf(COMMAND_DIRECTORY_SEPARATOR);
  if (separatorIndex < 0) {
    return {
      input: raw,
      cwd: '.',
      commandText: raw,
      hasExplicitCwd: false,
    };
  }
  const cwdText = raw.slice(0, separatorIndex).trim();
  const commandText = raw.slice(separatorIndex + COMMAND_DIRECTORY_SEPARATOR.length).trim();
  return {
    input: raw,
    cwd: normalizeCommandCwd(cwdText),
    commandText,
    hasExplicitCwd: true,
  };
}

export function formatCommandSpec({ cwd = '.', commandText = '' } = {}) {
  const normalizedCwd = normalizeCommandCwd(cwd);
  const command = String(commandText ?? '').trim();
  return normalizedCwd === '.' ? command : `${normalizedCwd}/ :: ${command}`;
}

export function normalizeCommandCwd(value) {
  const raw = String(value ?? '').trim().replaceAll('\\', '/');
  if (!raw || raw === '.' || raw === './') return '.';
  const withoutPrefix = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!withoutPrefix) return '.';
  return normalizeRelative(withoutPrefix);
}

export async function validateCommandSpec(projectRoot, value, { requireCommand = true } = {}) {
  const parsed = parseCommandSpec(value);
  if (requireCommand && !parsed.commandText) {
    const error = new Error('Enter the command Zipflow should run.');
    error.code = 'missing_command';
    throw error;
  }
  const cwdPath = await resolveCommandCwd(projectRoot, parsed.cwd);
  return { ...parsed, cwdPath };
}

export async function resolveCommandCwd(projectRoot, cwd = '.') {
  const normalized = normalizeCommandCwd(cwd);
  if (normalized === '.') {
    const info = await stat(projectRoot).catch(() => null);
    if (!info?.isDirectory()) {
      const error = new Error('The workspace root is not available.');
      error.code = 'missing_command_directory';
      throw error;
    }
    return path.resolve(projectRoot);
  }
  let safe;
  try {
    safe = await assertSafeProjectPath(projectRoot, normalized, { allowMissingLeaf: false });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const missing = new Error(`Command directory not found: ${normalized}/`);
      missing.code = 'missing_command_directory';
      throw missing;
    }
    throw error;
  }
  const info = await stat(safe.target).catch(() => null);
  if (!info?.isDirectory()) {
    const error = new Error(`Command directory not found: ${normalized}/`);
    error.code = 'missing_command_directory';
    throw error;
  }
  return safe.target;
}

export function commandLocationLabel(cwd = '.') {
  const normalized = normalizeCommandCwd(cwd);
  return normalized === '.' ? 'Root' : `${normalized}/`;
}

export function commandPrefix(value) {
  const raw = String(value ?? '');
  const separatorIndex = raw.indexOf(COMMAND_DIRECTORY_SEPARATOR);
  return separatorIndex < 0 ? raw : raw.slice(0, separatorIndex);
}
