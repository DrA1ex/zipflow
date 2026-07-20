import path from 'node:path';

const EXACT_SENSITIVE = new Map([
  ['.env', 'Environment variables may contain credentials'],
  ['.npmrc', 'Registry configuration may contain an authentication token'],
  ['.pypirc', 'Package registry configuration may contain credentials'],
  ['credentials.json', 'Credential file'],
  ['secrets.json', 'Secrets file'],
  ['service-account.json', 'Cloud service-account credentials'],
  ['id_rsa', 'Private SSH key'],
  ['id_ed25519', 'Private SSH key'],
]);
const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.defaults'];
const GENERATED_DIRECTORIES = new Set(['node_modules', '.cache', 'coverage', '.next', '.nuxt', '.turbo', 'dist', 'build', 'target']);

export function inspectPotentiallySensitivePaths(paths, { pathSizes = new Map() } = {}) {
  return paths.map((relative) => inspectPath(relative, pathSizes.get(relative) ?? 0)).filter(Boolean);
}

export function sensitivePathMap(records) {
  return new Map(records.map((record) => [record.path, record]));
}

function inspectPath(relative, size) {
  const normalized = String(relative).replaceAll('\\', '/');
  const basename = path.posix.basename(normalized).toLowerCase();
  const segments = normalized.toLowerCase().split('/');
  const exact = EXACT_SENSITIVE.get(basename);
  if (exact) return record(normalized, exact, 'sensitive', size);
  if (basename.startsWith('.env') && !SAFE_ENV_SUFFIXES.some((suffix) => basename.endsWith(suffix))) {
    return record(normalized, 'Environment file may contain credentials', 'sensitive', size);
  }
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(basename)) {
    return record(normalized, 'Private key or certificate container', 'sensitive', size);
  }
  if (/(credential|secret|private[-_.]?key|access[-_.]?token|auth[-_.]?token)/i.test(basename)
    && !/(example|sample|template|schema|test|spec)/i.test(basename)) {
    return record(normalized, 'Filename suggests credentials or secrets', 'sensitive', size);
  }
  if (/\.(sqlite3?|db)$/i.test(basename)) return record(normalized, 'Local database may contain private or machine-specific data', 'private-data', size);
  const generated = segments.find((segment) => GENERATED_DIRECTORIES.has(segment));
  if (generated) return record(normalized, `Generated or cache directory: ${generated}/`, 'generated', size);
  if (size >= 100 * 1024 * 1024) return record(normalized, 'Very large file', 'large', size);
  return null;
}

function record(pathValue, reason, category, size) {
  return { path: pathValue, reason, category, size };
}
