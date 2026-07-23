import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  availableLanguages,
  configureI18n,
  translate,
  validateLanguagePack,
} from '../src/i18n/index.js';

test('English is the default interface language and built-in languages are discoverable', async () => {
  const storeSource = await readFile(new URL('../src/settings/store.js', import.meta.url), 'utf8');
  assert.match(storeSource, /interfaceLanguage: 'en'/);
  await configureI18n('en', { directory: await mkdtemp(path.join(os.tmpdir(), 'zipflow-language-')) });
  assert.equal(translate('Settings'), 'Settings');
});

test('built-in interface languages are discoverable and Russian translates shared UI', async () => {
  await configureI18n('ru', { directory: await mkdtemp(path.join(os.tmpdir(), 'zipflow-language-')) });
  const ids = availableLanguages().map((item) => item.id);
  for (const id of ['en', 'ru', 'de', 'fr', 'it', 'es']) assert.ok(ids.includes(id));
  assert.equal(translate('Settings', {}, 'ru'), 'Настройки');
  assert.equal(translate('Update policy', {}, 'ru'), 'Политика обновления');
});

test('radio markers are kept outside translation patterns', () => {
  assert.equal(
    translate('● Only clean Git-tracked files', {}, 'ru'),
    '● Только чистые файлы под контролем Git',
  );
  assert.equal(translate('○ Only clean Git-tracked files', {}, 'ru'), '○ Только чистые файлы под контролем Git');
  assert.equal(translate('12 files', {}, 'ru'), 'Файлов: 12');
  assert.equal(translate('Review source files', {}, 'ru'), 'Review source files');
});

test('valid custom JSON packs are loaded automatically and invalid packs are ignored', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zipflow-language-'));
  await writeFile(path.join(directory, 'pirate.json'), JSON.stringify({
    version: 1, id: 'pirate', locale: 'en-PI', name: 'Pirate', nativeName: 'Pirate',
    messages: { Settings: 'Ship settings' }, patterns: [],
  }));
  await writeFile(path.join(directory, 'invalid.json'), '{"version":2}');
  const snapshot = await configureI18n('pirate', { directory });
  assert.ok(snapshot.available.some((item) => item.id === 'pirate' && !item.builtin));
  assert.ok(!snapshot.available.some((item) => item.id === 'invalid'));
  assert.equal(translate('Settings'), 'Ship settings');
  assert.equal(translate('Update policy'), 'Update policy');
});

test('language-pack validation enforces the published schema contract', () => {
  assert.throws(() => validateLanguagePack({
    version: 2, id: 'bad', locale: 'x', name: 'Bad', nativeName: 'Bad', messages: { Settings: 1 },
    unsupported: true, patterns: [{ source: '', target: '', extra: true }],
  }), /unsupported fields: unsupported.*version must be 1.*locale must be a string between 2 and 64 characters.*messages value must be a string.*patterns\[0\] has unsupported fields: extra.*non-empty string source/);
});

test('Russian menu rows keep help only in the context dock', async () => {
  const { renderToString, stripAnsi } = await import('terlio.js');
  const { createInitialState, setScreen } = await import('../src/app/state.js');
  const { renderZipflow } = await import('../src/ui/render.js');
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], technologies: [{ id: 'node' }], checks: [], git: true };
  state.settings.interfaceLanguage = 'ru';
  state.i18n = { languageId: 'ru', available: [] };
  setScreen(state, 'home', {
    items: [{
      id: 'review',
      label: 'Review changes',
      description: 'Open file groups and inspect unified or side-by-side diffs',
    }],
    status: 'Ready',
  });

  const output = stripAnsi(renderToString(renderZipflow({ state, width: 100, height: 28 }), { width: 100, height: 28 }));
  const menuLine = output.split('\n').find((line) => line.includes('› Просмотреть изменения')) ?? '';
  assert.ok(menuLine, output);
  assert.doesNotMatch(menuLine, /Открыть группы файлов/);
  assert.match(output, /Открыть группы файлов и просмотреть объединённые или параллельные различия/);
  assert.match(output, /Выбор 1\/1/);
});

test('Russian language pack covers static menu labels and context help', async () => {
  const { readdir, readFile: readText } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const locale = JSON.parse(await readText(new URL('../src/i18n/locales/ru.json', import.meta.url), 'utf8'));
  const translated = new Set([
    ...Object.keys(locale.messages),
    ...(locale.patterns ?? []).map((entry) => entry.source),
  ]);
  const technical = new Set([
    'Git', 'Go', 'Python', 'CMake · C/C++', 'CMake and C++', 'npm run test:custom', 'tsc --noEmit',
    '~/zipflow-archive', '~/Downloads/project-update.zip', 'zipflow: apply {runId}', 'utf8',
  ]);
  const missing = [];

  function shouldIgnore(value) {
    return !value || value.includes('${') || technical.has(value)
      || value.startsWith('.') || value.startsWith('/') || value.startsWith('~')
      || (/^[A-Za-z0-9_.:/@-]+$/.test(value) && !value.includes(' '));
  }

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith('.js')) {
        const source = await readText(target, 'utf8');
        const patterns = [
          /\b(label|description|context|help|disabledReason|title|placeholder|unitHint)\s*:\s*(['"])((?:\\.|(?!\2).)*)\2/g,
          /\bt\s*\(\s*(?:state\s*,\s*)?(['"])((?:\\.|(?!\1).)*)\1/g,
          /\.(?:toast|setStatus)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/g,
          /\b(?:state|controller\.state)\.status\s*=\s*(['"])((?:\\.|(?!\1).)*)\1/g,
        ];
        for (const pattern of patterns) {
          for (const match of source.matchAll(pattern)) {
            const valueIndex = pattern === patterns[0] ? 3 : 2;
            const value = match[valueIndex].replace(/\\(['"])/g, '$1').replace(/\\n/g, '\n');
            if (shouldIgnore(value) || translated.has(value)) continue;
            missing.push(`${path.relative(root, target)}: ${value}`);
          }
        }
      }
    }
  }

  await visit(path.join(root, 'app'));
  await visit(path.join(root, 'ui'));
  await visit(path.join(root, 'workflow'));
  assert.deepEqual(missing, []);
});
