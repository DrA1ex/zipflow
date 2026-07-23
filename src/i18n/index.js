import path from 'node:path';
import { chmod, mkdir, readdir, readFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getZipflowHome } from '../workflow/store.js';

const BUILTIN_DIRECTORY = fileURLToPath(new URL('./locales/', import.meta.url));
const LANGUAGE_VERSION = 1;
const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const NUMERIC_PATTERN_NAMES = new Set([
  'count', 'current', 'deleted', 'end', 'files', 'index', 'shown', 'start', 'total', 'updated',
]);
const builtins = loadBuiltins();
let registry = new Map(builtins);
let configuredLanguage = 'en';
let activeLanguage = resolveLanguageId(configuredLanguage, registry);
let userDirectory = null;

export async function configureI18n(language = 'en', { directory = languageDirectory() } = {}) {
  userDirectory = path.resolve(directory);
  await mkdir(userDirectory, { recursive: true, mode: 0o700 });
  await chmod(userDirectory, 0o700).catch(() => {});
  registry = new Map(builtins);
  for (const pack of await loadLanguageDirectory(userDirectory)) registry.set(pack.id, pack);
  configuredLanguage = normalizeConfiguredLanguage(language);
  activeLanguage = resolveLanguageId(configuredLanguage, registry);
  return i18nSnapshot();
}

export function i18nSnapshot() {
  return {
    configuredLanguage,
    languageId: activeLanguage,
    directory: userDirectory ?? languageDirectory(),
    available: availableLanguages(),
  };
}

export function availableLanguages() {
  return [...registry.values()]
    .map(({ id, locale, name, nativeName, builtin = false }) => ({ id, locale, name, nativeName, builtin }))
    .sort((left, right) => left.nativeName.localeCompare(right.nativeName, left.locale));
}

export function translate(source, variables = {}, language = activeLanguage) {
  const text = String(source ?? '');
  if (!text) return text;
  const decoration = splitLeadingChoiceMarker(text);
  const id = resolveLanguageId(language, registry);
  const pack = registry.get(id) ?? registry.get('en');
  const translated = translateWithPack(pack, decoration.text)
    ?? translateWithPack(registry.get('en'), decoration.text)
    ?? decoration.text;
  return `${decoration.prefix}${interpolate(translated, variables)}`;
}

export function translateForState(state, source, variables = {}) {
  const language = state?.i18n?.languageId
    ?? resolveLanguageId(state?.settings?.interfaceLanguage ?? configuredLanguage, registry);
  return translate(source, variables, language);
}

export function localizeUiItem(state, item) {
  if (!item || typeof item !== 'object') return item;
  return {
    ...item,
    label: localizeUiValue(state, item.label),
    value: localizeUiValue(state, item.value),
    description: localizeUiValue(state, item.description),
    context: localizeUiValue(state, item.context),
    disabledReason: localizeUiValue(state, item.disabledReason),
    help: localizeUiValue(state, item.help),
    helpTitle: localizeUiValue(state, item.helpTitle),
    helpLines: Array.isArray(item.helpLines)
      ? item.helpLines.map((line) => localizeUiValue(state, line))
      : item.helpLines,
  };
}

function localizeUiValue(state, value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? translateForState(state, value) : value;
}

export function validateLanguagePack(value, { source = 'language pack' } = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('root must be an object');
  else {
    const allowedRootKeys = new Set(['$schema', 'version', 'id', 'locale', 'name', 'nativeName', 'messages', 'patterns']);
    const unknownRootKeys = Object.keys(value).filter((key) => !allowedRootKeys.has(key));
    if (unknownRootKeys.length) errors.push(`unsupported fields: ${unknownRootKeys.join(', ')}`);
    if (value.$schema !== undefined && typeof value.$schema !== 'string') errors.push('$schema must be a string');
    if (value.version !== LANGUAGE_VERSION) errors.push(`version must be ${LANGUAGE_VERSION}`);
    if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) errors.push('id must match ^[a-z][a-z0-9-]{1,31}$');
    validateBoundedString(value, 'locale', 2, 64, errors);
    validateBoundedString(value, 'name', 1, 80, errors);
    validateBoundedString(value, 'nativeName', 1, 80, errors);
    if (!value.messages || typeof value.messages !== 'object' || Array.isArray(value.messages)) errors.push('messages must be an object');
    else if (Object.values(value.messages).some((entry) => typeof entry !== 'string')) errors.push('every messages value must be a string');
    if (value.patterns !== undefined) {
      if (!Array.isArray(value.patterns)) errors.push('patterns must be an array');
      else for (const [index, entry] of value.patterns.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`patterns[${index}] must be an object`);
          continue;
        }
        const unknownPatternKeys = Object.keys(entry).filter((key) => !['source', 'target'].includes(key));
        if (unknownPatternKeys.length) errors.push(`patterns[${index}] has unsupported fields: ${unknownPatternKeys.join(', ')}`);
        if (typeof entry.source !== 'string' || !entry.source.length || typeof entry.target !== 'string') {
          errors.push(`patterns[${index}] must contain a non-empty string source and string target`);
          continue;
        }
        const sourceNames = new Set([...entry.source.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]));
        const targetNames = [...entry.target.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]);
        const unknown = targetNames.filter((name) => !sourceNames.has(name));
        if (unknown.length) errors.push(`patterns[${index}] target uses unknown placeholders: ${[...new Set(unknown)].join(', ')}`);
      }
    }
  }
  if (errors.length) {
    const error = new Error(`Invalid Zipflow ${source}: ${errors.join('; ')}`);
    error.code = 'invalid-language-pack';
    error.validationErrors = errors;
    throw error;
  }
  return normalizePack(value);
}

function validateBoundedString(value, key, minLength, maxLength, errors) {
  if (typeof value[key] !== 'string' || value[key].length < minLength || value[key].length > maxLength || !value[key].trim()) {
    errors.push(`${key} must be a string between ${minLength} and ${maxLength} characters`);
  }
}

export function languageDirectory() {
  return path.join(getZipflowHome(), 'languages');
}

export function resolveSystemLanguage() {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || process.env.LC_ALL || process.env.LANG || 'en';
  const normalized = String(locale).toLowerCase();
  const exact = [...registry.values()].find((pack) => pack.locale.toLowerCase() === normalized)?.id;
  if (exact) return exact;
  const prefix = normalized.split(/[-_.]/)[0];
  return registry.has(prefix) ? prefix : 'en';
}

function loadBuiltins() {
  const result = new Map();
  for (const name of readdirSync(BUILTIN_DIRECTORY).filter((value) => value.endsWith('.json')).sort()) {
    const target = path.join(BUILTIN_DIRECTORY, name);
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    const pack = { ...validateLanguagePack(parsed, { source: name }), builtin: true, path: target };
    result.set(pack.id, pack);
  }
  if (!result.has('en')) throw new Error('Zipflow requires the built-in English language pack.');
  return result;
}

async function loadLanguageDirectory(directory) {
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const result = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const target = path.join(directory, entry.name);
      const parsed = JSON.parse(await readFile(target, 'utf8'));
      result.push({ ...validateLanguagePack(parsed, { source: entry.name }), builtin: false, path: target });
    } catch {
      // Invalid custom packs are ignored at startup; the settings page reports only packs that passed validation.
    }
  }
  return result;
}

function normalizePack(value) {
  return {
    version: LANGUAGE_VERSION,
    id: value.id,
    locale: value.locale,
    name: value.name,
    nativeName: value.nativeName,
    messages: { ...value.messages },
    patterns: (value.patterns ?? []).map((entry) => ({
      source: entry.source,
      target: entry.target,
      matcher: compilePattern(entry.source),
    })).sort((left, right) => right.source.length - left.source.length),
  };
}

function translateWithPack(pack, source) {
  if (!pack) return null;
  if (Object.prototype.hasOwnProperty.call(pack.messages, source)) return pack.messages[source];
  for (const pattern of pack.patterns) {
    if (pattern.source === source) return pattern.target;
    const match = pattern.matcher.regex.exec(source);
    if (!match) continue;
    const variables = Object.fromEntries(pattern.matcher.names.map((name, index) => [name, match[index + 1]]));
    return interpolate(pattern.target, variables);
  }
  return null;
}

function compilePattern(source) {
  const names = [];
  let cursor = 0;
  let expression = '^';
  for (const match of source.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
    expression += escapeRegex(source.slice(cursor, match.index));
    const name = match[1];
    expression += NUMERIC_PATTERN_NAMES.has(name)
      ? '([0-9][0-9A-Za-z.,_+%\\-\\s]*?)'
      : '(.+?)';
    names.push(name);
    cursor = match.index + match[0].length;
  }
  expression += `${escapeRegex(source.slice(cursor))}$`;
  return { names, regex: new RegExp(expression, 'u') };
}

function interpolate(value, variables) {
  return String(value ?? '').replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name) => (
    Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : `{${name}}`
  ));
}

function splitLeadingChoiceMarker(value) {
  const match = String(value ?? '').match(/^([●○]\s+)(.*)$/u);
  return match ? { prefix: match[1], text: match[2] } : { prefix: '', text: String(value ?? '') };
}

function normalizeConfiguredLanguage(value) {
  const id = String(value ?? 'system').trim().toLowerCase();
  return id === 'system' || registry.has(id) ? id : 'system';
}

function resolveLanguageId(value, packs) {
  const id = String(value ?? 'system').trim().toLowerCase();
  if (id === 'system') {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || process.env.LC_ALL || process.env.LANG || 'en';
    const normalized = String(locale).toLowerCase();
    const exact = [...packs.values()].find((pack) => pack.locale.toLowerCase() === normalized)?.id;
    if (exact) return exact;
    const prefix = normalized.split(/[-_.]/)[0];
    return packs.has(prefix) ? prefix : 'en';
  }
  return packs.has(id) ? id : 'en';
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
