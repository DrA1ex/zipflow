import os from 'node:os';
import path from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import { exists } from './fs.js';

export function expandHome(value) {
  const text = String(value ?? '').trim();
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

export function parseEnteredPath(value, cwd = process.cwd()) {
  let text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  text = text.replace(/\\ /g, ' ').replace(/\\([()\[\]{}'"&;])/g, '$1');
  const expanded = expandHome(text);
  return path.resolve(cwd, expanded || '.');
}

export async function canonicalPath(target) {
  return path.normalize(await realpath(path.resolve(target)));
}

export async function sameCanonicalPath(left, right) {
  const [canonicalLeft, canonicalRight] = await Promise.all([canonicalPath(left), canonicalPath(right)]);
  return canonicalLeft === canonicalRight;
}

export function displayPath(target) {
  const home = os.homedir();
  if (target === home) return '~';
  if (target.startsWith(`${home}${path.sep}`)) return `~${target.slice(home.length)}`;
  return target;
}

export async function completePath(value, { cwd = process.cwd(), directoriesOnly = false, extension = null } = {}) {
  const raw = String(value ?? '');
  const empty = raw.trim() === '';
  const parsed = parseEnteredPath(empty ? cwd : raw, cwd);
  const endsWithSeparator = empty || raw.endsWith('/') || raw.endsWith(path.sep);
  const directory = endsWithSeparator ? parsed : path.dirname(parsed);
  const prefix = endsWithSeparator ? '' : path.basename(parsed);
  if (!(await exists(directory))) return { value: raw, matches: [] };
  const entries = await readdir(directory, { withFileTypes: true });
  const matches = entries.filter((entry) => {
    if (!entry.name.startsWith(prefix)) return false;
    if (directoriesOnly && !entry.isDirectory()) return false;
    if (extension && !entry.isDirectory() && !entry.name.toLowerCase().endsWith(extension)) return false;
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (!matches.length) return { value: raw, matches: [] };
  const names = matches.map((entry) => `${entry.name}${entry.isDirectory() ? path.sep : ''}`);
  const common = commonPrefix(names);
  const nextName = matches.length === 1 ? names[0] : common.length > prefix.length ? common : null;
  const completed = nextName ? collapseHome(path.join(directory, nextName)) : raw;
  return { value: completed, matches: names.map((name) => path.join(directory, name)) };
}

function commonPrefix(values) {
  if (!values.length) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function collapseHome(target) {
  const home = os.homedir();
  return target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}
