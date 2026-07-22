import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  exportTreeItems,
  initializeExportTree,
  toggleTreeEntry,
} from '../src/app/export-tree.js';
import { inspectPotentiallySensitivePaths } from '../src/export/sensitive.js';

function sensitiveDraft(paths, selected = paths) {
  const sensitive = paths.map((path) => ({ path, reason: 'Filename suggests credentials or secrets', category: 'sensitive' }));
  return {
    paths,
    selectedPaths: new Set(selected),
    pathAnnotations: new Map(),
    sensitive,
    sensitiveMap: new Map(sensitive.map((record) => [record.path, record])),
  };
}

test('credential-like source filenames are not treated as secret files by name alone', () => {
  const records = inspectPotentiallySensitivePaths([
    'src/security/credential-store.js',
    'tools/secret_loader.py',
    'src/access-token.ts',
    'src/.env.js',
    'config/runtime-credentials.json',
    'credentials',
  ]);
  const paths = records.map((record) => record.path);

  assert.equal(paths.includes('src/security/credential-store.js'), false);
  assert.equal(paths.includes('tools/secret_loader.py'), false);
  assert.equal(paths.includes('src/access-token.ts'), false);
  assert.equal(paths.includes('src/.env.js'), false);
  assert.equal(paths.includes('config/runtime-credentials.json'), true);
  assert.equal(paths.includes('credentials'), true);
});

test('five or fewer sensitive files are shown as a flat full-path list', () => {
  const paths = [
    '.env',
    'config/private/credentials.json',
    'services/api/secrets.json',
    'keys/service-account.json',
  ];
  const draft = sensitiveDraft(paths);
  initializeExportTree(draft, { origin: 'sensitive', sensitiveOnly: true });

  const items = exportTreeItems(draft);
  assert.deepEqual(items.map((item) => item.kind), ['file', 'file', 'file', 'file']);
  assert.deepEqual(items.map((item) => item.path), [...paths].sort((left, right) => left.localeCompare(right)));
  assert.ok(items.some((item) => item.label.includes('config/private/credentials.json')));
  assert.ok(items.every((item) => item.navigate === false));
});

test('single-file sensitive directory branches collapse while real choices remain folders', () => {
  const paths = [
    'apps/a/config/credentials.json',
    'apps/b/config/credentials.json',
    'shared/one/secrets.json',
    'shared/two/secrets.json',
    'standalone/a/credentials.json',
    'standalone/b/credentials.json',
  ];
  const draft = sensitiveDraft(paths);
  initializeExportTree(draft, { origin: 'sensitive', sensitiveOnly: true });

  const items = exportTreeItems(draft);
  assert.ok(items.some((item) => item.kind === 'directory' && item.path === 'apps'));
  assert.ok(items.some((item) => item.kind === 'directory' && item.path === 'shared'));
  assert.ok(items.some((item) => item.kind === 'directory' && item.path === 'standalone'));

  draft.treeDirectory = 'apps/a';
  const nested = exportTreeItems(draft);
  assert.equal(nested.length, 1);
  assert.equal(nested[0].kind, 'file');
  assert.equal(nested[0].path, 'apps/a/config/credentials.json');
  assert.match(nested[0].label, /config\/credentials\.json/);
});

test('sensitive file markers update immediately after a toggle', () => {
  const paths = ['config/credentials.json'];
  const draft = sensitiveDraft(paths);
  initializeExportTree(draft, { origin: 'sensitive', sensitiveOnly: true });

  assert.match(exportTreeItems(draft)[0].label, /\[x\]/);
  toggleTreeEntry(draft, paths[0]);
  assert.match(exportTreeItems(draft)[0].label, /\[ \]/);
  toggleTreeEntry(draft, paths[0]);
  assert.match(exportTreeItems(draft)[0].label, /\[x\]/);
});

test('settings and shell source keep help compact and remove the misleading footer title', async () => {
  const [settingsSource, renderSource] = await Promise.all([
    readFile(new URL('../src/ui/settings-view.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/render.js', import.meta.url), 'utf8'),
  ]);

  assert.match(settingsSource, /const SETTINGS_CONTEXT_ROWS = 2/);
  assert.match(settingsSource, /joinContextLines\(pageContext, parameterDescription\)/);
  assert.match(settingsSource, /windowSize: Math\.max\(2, height - 7\)/);
  assert.match(renderSource, /WorkspaceFooter\(\{ title: '', left:/);
  assert.match(renderSource, /function showsInlineDescriptions\(screen\)/);
});
