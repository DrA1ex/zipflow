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
