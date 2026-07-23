import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const localeDirectory = path.resolve('src/i18n/locales');
const localeFiles = readdirSync(localeDirectory)
  .filter((name) => name.endsWith('.json'))
  .sort();
const packs = new Map(localeFiles.map((name) => {
  const pack = JSON.parse(readFileSync(path.join(localeDirectory, name), 'utf8'));
  return [pack.id, { ...pack, filename: name }];
}));
const english = packs.get('en');
let failed = false;

if (!english) fail('src/i18n/locales/en.json is required.');
else {
  for (const [source, target] of Object.entries(english.messages ?? {})) {
    if (source !== target) fail(`en.json must map the canonical source text to itself: ${JSON.stringify(source)}`);
  }
  for (const entry of english.patterns ?? []) {
    if (entry.source !== entry.target) fail(`en.json pattern target must equal its source: ${JSON.stringify(entry.source)}`);
  }

  const englishMessages = new Set(Object.keys(english.messages ?? {}));
  const englishPatterns = new Set((english.patterns ?? []).map((entry) => entry.source));
  for (const pack of packs.values()) {
    for (const source of Object.keys(pack.messages ?? {})) {
      if (!englishMessages.has(source)) fail(`${pack.filename} contains a message absent from canonical en.json: ${JSON.stringify(source)}`);
    }
    for (const entry of pack.patterns ?? []) {
      if (!englishPatterns.has(entry.source)) fail(`${pack.filename} contains a pattern absent from canonical en.json: ${JSON.stringify(entry.source)}`);
    }
  }

  const missing = findMissingStaticUiStrings(new Set([...englishMessages, ...englishPatterns]));
  for (const entry of missing) fail(`${entry.file}: English catalog is missing ${JSON.stringify(entry.value)}`);
}

if (failed) process.exitCode = 1;
else console.log(`Checked ${packs.size} language packs against canonical en.json.`);

function findMissingStaticUiStrings(catalog) {
  const root = path.resolve('src');
  const files = collect(root).filter((file) => file.endsWith('.js'));
  const technical = new Set([
    'Git', 'Go', 'Python', 'CMake · C/C++', 'CMake and C++', 'npm run test:custom', 'tsc --noEmit',
    '~/zipflow-archive', '~/Downloads/project-update.zip', 'zipflow: apply {runId}', 'utf8',
  ]);
  const patterns = [
    /\b(label|description|context|help|disabledReason|title|placeholder|unitHint)\s*:\s*(['"])((?:\\.|(?!\2).)*)\2/g,
    /\bt\s*\(\s*(?:state\s*,\s*)?(['"])((?:\\.|(?!\1).)*)\1/g,
    /\.(?:toast|setStatus)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/g,
    /\b(?:state|controller\.state)\.status\s*=\s*(['"])((?:\\.|(?!\1).)*)\1/g,
  ];
  const missing = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const valueIndex = pattern === patterns[0] ? 3 : 2;
        const value = match[valueIndex].replace(/\\(['"])/g, '$1').replace(/\\n/g, '\n');
        if (shouldIgnore(value, technical) || catalog.has(value)) continue;
        missing.push({ file: path.relative(root, file), value });
      }
    }
  }
  return missing;
}

function shouldIgnore(value, technical) {
  return !value || value.includes('${') || technical.has(value)
    || value.startsWith('.') || value.startsWith('/') || value.startsWith('~')
    || (/^[A-Za-z0-9_.:/@-]+$/.test(value) && !value.includes(' '));
}

function collect(root) {
  try {
    return statSync(root).isDirectory()
      ? readdirSync(root).flatMap((entry) => collect(path.join(root, entry)))
      : [root];
  } catch {
    return [];
  }
}

function fail(message) {
  console.error(message);
  failed = true;
}
