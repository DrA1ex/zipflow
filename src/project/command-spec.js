import path from 'node:path';
import { stat } from 'node:fs/promises';
import { assertSafeProjectPath, normalizeRelative } from '../security/project-path.js';

export const COMMAND_DIRECTORY_SEPARATOR = '::';

export function parseCommandSpec(value) {
  const raw = String(value ?? '').trim();
  const separatorIndex = commandDirectorySeparatorIndex(raw);
  if (separatorIndex < 0) return rootCommand(raw);
  const cwdText = raw.slice(0, separatorIndex).trim();
  if (!looksLikeCommandDirectory(cwdText)) return rootCommand(raw);
  const commandText = raw.slice(separatorIndex + COMMAND_DIRECTORY_SEPARATOR.length).trim();
  return {
    input: raw,
    cwd: normalizeCommandCwd(unquoteCommandDirectory(cwdText)),
    commandText,
    hasExplicitCwd: true,
  };
}

export function formatCommandSpec({ cwd = '.', commandText = '' } = {}) {
  const normalizedCwd = normalizeCommandCwd(cwd);
  const command = String(commandText ?? '').trim();
  return normalizedCwd === '.' ? command : `${quoteCommandDirectory(`${normalizedCwd}/`)} :: ${command}`;
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
  const separatorIndex = commandDirectorySeparatorIndex(raw);
  if (separatorIndex < 0) return raw;
  const cwdText = raw.slice(0, separatorIndex).trim();
  return looksLikeCommandDirectory(cwdText) ? raw.slice(0, separatorIndex) : raw;
}

function rootCommand(raw) {
  return { input: raw, cwd: '.', commandText: raw, hasExplicitCwd: false };
}

function commandDirectorySeparatorIndex(value) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ':' && value[index + 1] === ':') return index;
  }
  return -1;
}

function looksLikeCommandDirectory(value) {
  if (!value) return false;
  if (isQuoted(value)) return value.length > 2;
  return isSafeUnquotedDirectory(value);
}

function isQuoted(value) {
  return value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
}

function unquoteCommandDirectory(value) {
  if (!isQuoted(value)) return value;
  if (value[0] === "'") return value.slice(1, -1);
  try { return JSON.parse(value); } catch { return value; }
}

function quoteCommandDirectory(value) {
  return isSafeUnquotedDirectory(value) ? value : JSON.stringify(value);
}

function isSafeUnquotedDirectory(value) {
  return Boolean(value) && !/[\s"'`$;&|<>()[\]{}]/.test(value);
}
