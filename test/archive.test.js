import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import yazl from 'yazl';
import { extractArchive } from '../src/archive/extract.js';
import { validateZipEntry } from '../src/archive/security.js';
import { tempDir } from '../test-support/helpers.js';

test('rejects traversal and .git archive paths', () => {
  assert.throws(() => validateZipEntry(entry('../outside.js')), /escapes the project/);
  assert.throws(() => validateZipEntry(entry('.git/config')), /not allowed to modify \.git/);
});

test('extracts a single wrapper directory as the archive root', async () => {
  const root = await tempDir();
  const archive = path.join(root, 'fixture.zip');
  await createZip(archive, {
    'fixture/package.json': '{}',
    'fixture/src/index.js': 'export {};\n',
  });

  const extracted = await extractArchive(archive, path.join(root, 'out'));

  assert.equal(extracted.rootPrefix, 'fixture');
  assert.deepEqual(extracted.entries.map((item) => item.relativePath), ['package.json', 'src/index.js']);
});

test('does not strip a single source directory without project markers', async () => {
  const root = await tempDir();
  const archive = path.join(root, 'source-only.zip');
  await createZip(archive, { 'src/index.js': 'export {};\n' });

  const extracted = await extractArchive(archive, path.join(root, 'out-source'));

  assert.equal(extracted.rootPrefix, null);
  assert.deepEqual(extracted.entries.map((item) => item.relativePath), ['src/index.js']);
});

function entry(fileName) {
  return { fileName, externalFileAttributes: 0, uncompressedSize: 10, compressedSize: 10 };
}

function createZip(target, files) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
    zip.outputStream.pipe(createWriteStream(target)).on('close', resolve).on('error', reject);
    zip.end();
  });
}

test('rejects case-colliding entries before they can overwrite each other', async () => {
  const root = await tempDir();
  const archive = path.join(root, 'collision.zip');
  await createZip(archive, { 'src/File.js': 'one', 'src/file.js': 'two' });

  await assert.rejects(
    extractArchive(archive, path.join(root, 'out-collision')),
    /duplicate or case-colliding paths/,
  );
});

test('extracts ordinary dotfiles instead of treating them as hidden metadata', async () => {
  const root = await tempDir('zipflow-archive-dotfiles-');
  const archive = path.join(root, 'dotfiles.zip');
  await createZip(archive, {
    '.DS_Store': 'not ignored by Zipflow itself',
    '.config/tool.json': '{"enabled":true}',
    '.github/workflows/test.yml': 'name: test\n',
  });

  const extracted = await extractArchive(archive, path.join(root, 'out-dotfiles'));

  assert.deepEqual(extracted.entries.map((item) => item.relativePath), [
    '.DS_Store',
    '.config/tool.json',
    '.github/workflows/test.yml',
  ]);
});
