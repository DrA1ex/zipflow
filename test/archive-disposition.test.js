import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { applySourceArchivePolicy } from '../src/archive/disposition.js';
import { exists } from '../src/utils/fs.js';
import { tempDir } from '../test-support/helpers.js';

async function withHome(run) {
  const previous = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-archive-policy-home-');
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
  }
}

test('source archive policy keeps the ZIP in place by default', async () => withHome(async () => {
  const root = await tempDir('zipflow-source-keep-');
  const archive = path.join(root, 'update.zip');
  await writeFile(archive, 'zip');

  const result = await applySourceArchivePolicy({ archivePath: archive, runId: 'run-keep', settings: { archivePolicy: 'keep' } });

  assert.equal(result.action, 'kept');
  assert.equal(await readFile(archive, 'utf8'), 'zip');
}));

test('move policy creates the archive directory and only prunes Zipflow-managed files by retention', async () => withHome(async () => {
  const source = await tempDir('zipflow-source-move-');
  const storage = path.join(await tempDir('zipflow-storage-parent-'), 'nested', 'archives');
  const oldArchive = path.join(source, 'old.zip');
  const newArchive = path.join(source, 'new.zip');
  await writeFile(oldArchive, 'old');

  const settings = {
    archivePolicy: 'move', archiveDirectory: storage,
    archiveRetentionDays: 30, archiveMaxBytes: 1024 ** 2,
  };
  const oldResult = await applySourceArchivePolicy({
    archivePath: oldArchive, runId: 'run-old', settings, now: new Date('2026-01-01T00:00:00Z'),
  });
  const unrelated = path.join(storage, 'manual.txt');
  await writeFile(unrelated, 'keep me');
  await writeFile(newArchive, 'new');
  const newResult = await applySourceArchivePolicy({
    archivePath: newArchive, runId: 'run-new', settings, now: new Date('2026-03-01T00:00:00Z'),
  });

  assert.equal(oldResult.action, 'moved');
  assert.equal(newResult.action, 'moved');
  assert.equal(await exists(oldResult.path), false);
  assert.equal(await readFile(newResult.path, 'utf8'), 'new');
  assert.equal(await readFile(unrelated, 'utf8'), 'keep me');
  assert.ok(newResult.pruned.some((item) => item.reason === 'retention' && item.runId === 'run-old'));
}));

test('move policy removes oldest managed archives when the size limit is exceeded', async () => withHome(async () => {
  const source = await tempDir('zipflow-source-size-');
  const storage = await tempDir('zipflow-storage-size-');
  const settings = {
    archivePolicy: 'move', archiveDirectory: storage,
    archiveRetentionDays: 0, archiveMaxBytes: 150,
  };
  const first = path.join(source, 'first.zip');
  const second = path.join(source, 'second.zip');
  await writeFile(first, 'a'.repeat(100));
  await writeFile(second, 'b'.repeat(100));

  const firstResult = await applySourceArchivePolicy({ archivePath: first, runId: 'run-1', settings, now: new Date('2026-01-01T00:00:00Z') });
  const secondResult = await applySourceArchivePolicy({ archivePath: second, runId: 'run-2', settings, now: new Date('2026-01-02T00:00:00Z') });

  assert.equal(await exists(firstResult.path), false);
  assert.equal(await exists(secondResult.path), true);
  assert.ok(secondResult.pruned.some((item) => item.reason === 'size' && item.runId === 'run-1'));
}));

test('delete policy removes the uploaded source archive', async () => withHome(async () => {
  const root = await tempDir('zipflow-source-delete-');
  const archive = path.join(root, 'update.zip');
  await writeFile(archive, 'zip');

  const result = await applySourceArchivePolicy({ archivePath: archive, runId: 'run-delete', settings: { archivePolicy: 'delete' } });

  assert.equal(result.action, 'deleted');
  assert.equal(await exists(archive), false);
}));

test('completed-run archive finalization records the disposition without failing the update', async () => withHome(async () => {
  const { finalizeSourceArchive } = await import('../src/app/archive-policy.js');
  const { createRunRecord } = await import('../src/runs/store.js');
  const source = await tempDir('zipflow-finalize-source-');
  const storage = await tempDir('zipflow-finalize-storage-');
  const archive = path.join(source, 'update.zip');
  await writeFile(archive, 'zip');
  const run = await createRunRecord({
    id: 'run-finalize',
    project: { root: source, name: 'fixture' },
    workflow: { name: 'fixture' },
    archivePath: archive,
  });
  const messages = [];
  const controller = {
    state: {
      run,
      settings: {
        archivePolicy: 'move', archiveDirectory: storage,
        archiveRetentionDays: 30, archiveMaxBytes: 1024 ** 3,
      },
    },
    message: (title, lines, tone) => messages.push({ title, lines, tone }),
  };

  const result = await finalizeSourceArchive(controller);

  assert.equal(result.action, 'moved');
  assert.equal(controller.state.run.archiveDisposition.action, 'moved');
  assert.equal(await exists(result.path), true);
  assert.ok(messages.some((message) => message.title === 'Source archive moved'));
}));

test('source archive finalization leaves a replacement file untouched when its inspected hash changed', async () => withHome(async () => {
  const { finalizeSourceArchive } = await import('../src/app/archive-policy.js');
  const { createRunRecord } = await import('../src/runs/store.js');
  const source = await tempDir('zipflow-finalize-race-source-');
  const archive = path.join(source, 'update.zip');
  await writeFile(archive, 'replacement archive');
  const run = await createRunRecord({
    id: 'run-finalize-race',
    project: { root: source, name: 'fixture' },
    workflow: { name: 'fixture' },
    archivePath: archive,
    archiveHash: 'hash-recorded-during-inspection',
  });
  const messages = [];
  const controller = {
    state: { run, settings: { archivePolicy: 'delete' } },
    message: (title, lines, tone) => messages.push({ title, lines, tone }),
  };

  const result = await finalizeSourceArchive(controller);

  assert.equal(result.action, 'failed');
  assert.match(result.error, /changed after it was inspected/);
  assert.equal(await exists(archive), true);
  assert.equal(await readFile(archive, 'utf8'), 'replacement archive');
  assert.ok(messages.some((message) => message.title === 'Source archive policy could not be applied'));
}));
