import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { extractArchive, extractArchiveFromSource } from '../src/archive/extract.js';
import { openArchiveSource } from '../src/archive/source.js';
import { exists } from '../src/utils/fs.js';
import { hashFile } from '../src/utils/hash.js';
import { createZip, tempDir } from '../test-support/helpers.js';

test('release-hardening phase 5: extracted content and stored source hash come from one private snapshot', async () => {
  const root = await tempDir('zipflow-phase5-archive-hash-');
  const archive = path.join(root, 'update.zip');
  await createZip(archive, { 'src/file.txt': 'descriptor content\n' });
  const expectedHash = await hashFile(archive);
  const extracted = await extractArchive(archive, path.join(root, 'out'));
  assert.equal(extracted.archiveHash, expectedHash);
  assert.equal(await readFile(path.join(extracted.root, 'src', 'file.txt'), 'utf8'), 'descriptor content\n');
});

test('release-hardening phase 5: replacing the archive pathname cannot substitute extracted bytes', async () => {
  const root = await tempDir('zipflow-phase5-archive-replace-');
  const archive = path.join(root, 'update.zip');
  const openedArchive = path.join(root, 'opened.zip');
  await createZip(archive, { 'original.txt': 'original\n' });
  const source = await openArchiveSource(archive);
  try {
    await rename(archive, openedArchive);
    await createZip(archive, { 'replacement.txt': 'replacement\n' });
    const extracted = await extractArchiveFromSource(source, path.join(root, 'out'));
    assert.equal(await readFile(path.join(extracted.root, 'original.txt'), 'utf8'), 'original\n');
    assert.equal(await exists(path.join(extracted.root, 'replacement.txt')), false);
    assert.equal(source.hash, await hashFile(openedArchive));
  } finally {
    await source.close();
  }
});

test('release-hardening phase 5: extraction space failure leaves the previous destination untouched', async () => {
  const root = await tempDir('zipflow-phase5-extract-space-');
  const archive = path.join(root, 'update.zip');
  const destination = path.join(root, 'out');
  await createZip(archive, { 'file.txt': 'content\n' });
  await writeFile(destination, 'sentinel');
  await assert.rejects(extractArchive(archive, destination, {
    diskSpaceProbe: async () => ({ device: 1n, available: 0 }),
  }), (error) => error.code === 'insufficient_disk_space');
  assert.equal(await readFile(destination, 'utf8'), 'sentinel');
});
