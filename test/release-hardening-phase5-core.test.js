import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { openArchiveSource, withArchiveSource } from '../src/archive/source.js';
import { createBackup } from '../src/apply/backup.js';
import { inspectRollback } from '../src/apply/rollback.js';
import { applyUpdatePlan } from '../src/apply/apply.js';
import { assertCapacity, estimateArchiveExtractionRequirements } from '../src/storage/disk-space.js';
import { exists, readJson } from '../src/utils/fs.js';
import { hashFile, hashText } from '../src/utils/hash.js';

test('release-hardening phase 5: a private snapshot is stable when the selected pathname is replaced', async () => {
  const root = await tempDir('zipflow-phase5-source-');
  const archive = path.join(root, 'update.zip');
  const moved = path.join(root, 'opened.zip');
  await writeFile(archive, 'original archive bytes');
  const source = await openArchiveSource(archive);
  try {
    assert.equal(source.hash, hashText('original archive bytes'));
    await rename(archive, moved);
    await writeFile(archive, 'replacement archive bytes');
    assert.equal(await hashFile(moved), source.hash);
    assert.equal(await source.verify(), true);
    assert.equal(await hashFile(source.snapshotPath), source.hash);
    assert.notEqual(await hashFile(archive), source.hash);
  } finally {
    await source.close();
  }
});

test('release-hardening phase 5: later source mutation cannot alter the private snapshot', async () => {
  const root = await tempDir('zipflow-phase5-source-mutation-');
  const archive = path.join(root, 'update.zip');
  await writeFile(archive, 'original archive bytes');
  const source = await openArchiveSource(archive);
  try {
    await writeFile(archive, 'modified archive bytes');
    assert.equal(await source.verify(), true);
    assert.equal(await hashFile(source.snapshotPath), source.hash);
    assert.notEqual(await hashFile(archive), source.hash);
  } finally {
    await source.close();
  }
});


test('release-hardening phase 5: private snapshot cleanup waits for the async owner', async () => {
  const root = await tempDir('zipflow-phase5-source-lifetime-');
  const archive = path.join(root, 'update.zip');
  await writeFile(archive, 'archive bytes');
  let releaseOwner;
  const ownerReleased = new Promise((resolve) => { releaseOwner = resolve; });
  let snapshotPath = null;
  let ownerStarted;
  const started = new Promise((resolve) => { ownerStarted = resolve; });

  const inspection = withArchiveSource(archive, async (source) => {
    snapshotPath = source.snapshotPath;
    ownerStarted();
    await ownerReleased;
    assert.equal(await exists(snapshotPath), true);
  });

  await started;
  assert.equal(await exists(snapshotPath), true);
  releaseOwner();
  await inspection;
  assert.equal(await exists(snapshotPath), false);
});

test('release-hardening phase 5: backup publication is atomic and records verified hashes', async () => {
  const home = await tempDir('zipflow-phase5-backup-home-');
  const project = await tempDir('zipflow-phase5-backup-project-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const currentPath = path.join(project, 'src', 'file.txt');
    await writeFiles(project, { 'src/file.txt': 'before\n' });
    const beforeHash = await hashFile(currentPath);
    const backup = await createBackup({
      runId: 'phase5-atomic-backup',
      projectPath: project,
      items: [{
        kind: 'updated', path: 'src/file.txt', currentPath,
        beforeHash, afterHash: hashText('after\n'),
      }],
    });
    const manifest = await readJson(path.join(backup.root, 'manifest.json'));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.items[0].backupHash, beforeHash);
    assert.equal(await readFile(path.join(backup.root, 'files', 'src', 'file.txt'), 'utf8'), 'before\n');
    const entries = await readdir(path.join(home, 'backups'));
    assert.deepEqual(entries, ['phase5-atomic-backup']);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

test('release-hardening phase 5: a failed backup is never published as valid', async () => {
  const home = await tempDir('zipflow-phase5-partial-home-');
  const project = await tempDir('zipflow-phase5-partial-project-');
  process.env.ZIPFLOW_HOME = home;
  try {
    await writeFiles(project, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const items = [
      { kind: 'updated', path: 'a.txt', beforeHash: await hashFile(path.join(project, 'a.txt')), afterHash: hashText('new a\n') },
      { kind: 'updated', path: 'b.txt', beforeHash: 'not-the-current-hash', afterHash: hashText('new b\n') },
    ];
    await assert.rejects(createBackup({ runId: 'phase5-partial', projectPath: project, items }), (error) => {
      assert.equal(error.code, 'backup_integrity');
      assert.match(error.message, /b\.txt/);
      return true;
    });
    assert.equal(await exists(path.join(home, 'backups', 'phase5-partial')), false);
    assert.deepEqual(await readdir(path.join(home, 'backups')), []);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

test('release-hardening phase 5: rollback refuses a modified backup before project mutation', async () => {
  const home = await tempDir('zipflow-phase5-rollback-home-');
  const project = await tempDir('zipflow-phase5-rollback-project-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const currentPath = path.join(project, 'file.txt');
    await writeFile(currentPath, 'before\n');
    const beforeHash = await hashFile(currentPath);
    const afterHash = hashText('after\n');
    const backup = await createBackup({
      runId: 'phase5-corrupt-rollback', projectPath: project,
      items: [{ kind: 'updated', path: 'file.txt', currentPath, beforeHash, afterHash }],
    });
    await writeFile(currentPath, 'after\n');
    await writeFile(path.join(backup.root, 'files', 'file.txt'), 'tampered\n');
    await assert.rejects(inspectRollback('phase5-corrupt-rollback'), (error) => {
      assert.equal(error.code, 'backup_integrity');
      assert.match(error.message, /file\.txt.*expected.*found/i);
      return true;
    });
    assert.equal(await readFile(currentPath, 'utf8'), 'after\n');
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});


test('release-hardening phase 5: legacy version 1 backups remain rollback-compatible when hashes match', async () => {
  const home = await tempDir('zipflow-phase5-legacy-home-');
  const project = await tempDir('zipflow-phase5-legacy-project-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const runId = 'phase5-legacy';
    const root = path.join(home, 'backups', runId);
    const filesRoot = path.join(root, 'files');
    await mkdir(filesRoot, { recursive: true });
    const currentPath = path.join(project, 'file.txt');
    const backupPath = path.join(filesRoot, 'file.txt');
    await writeFile(currentPath, 'after\n');
    await writeFile(backupPath, 'before\n');
    const beforeHash = await hashFile(backupPath);
    const afterHash = await hashFile(currentPath);
    const createdAt = new Date().toISOString();
    await writeFile(path.join(root, 'binding.json'), `${JSON.stringify({ version: 1, runId, projectPath: project, createdAt }, null, 2)}\n`);
    await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify({
      version: 1, runId, projectPath: project, filesRoot, createdAt,
      items: [{ kind: 'updated', path: 'file.txt', existed: true, beforeHash, afterHash, mode: 0o644 }],
    }, null, 2)}\n`);
    const inspection = await inspectRollback(runId);
    assert.equal(inspection.available, true);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

test('release-hardening phase 5: disk requirements on the same filesystem are aggregated', async () => {
  const checks = [
    { label: 'Zipflow storage', path: '/zipflow', required: 7_000_000 },
    { label: 'project filesystem', path: '/project', required: 5_000_000 },
  ];
  await assert.rejects(assertCapacity(checks, {
    probe: async () => ({ device: 42n, available: 10_000_000 }),
  }), (error) => {
    assert.equal(error.code, 'insufficient_disk_space');
    assert.equal(error.requiredBytes, 12_000_000);
    assert.equal(error.availableBytes, 10_000_000);
    assert.match(error.message, /required.*available/i);
    return true;
  });
  const estimate = estimateArchiveExtractionRequirements({ archiveBytes: 2_000_000, expandedBytes: 10_000_000, entryCount: 20 });
  assert.ok(estimate.total > 10_000_000);
  assert.ok(estimate.metadata > 0);
  assert.ok(estimate.reserve > 0);
});

test('release-hardening phase 5: apply disk preflight fails before backup or project mutation', async () => {
  const home = await tempDir('zipflow-phase5-space-home-');
  const project = await tempDir('zipflow-phase5-space-project-');
  const sourceRoot = await tempDir('zipflow-phase5-space-source-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const currentPath = path.join(project, 'file.txt');
    const sourcePath = path.join(sourceRoot, 'file.txt');
    await writeFile(currentPath, 'before\n');
    await writeFile(sourcePath, 'after\n');
    const plan = {
      created: [],
      updated: [{
        kind: 'updated', path: 'file.txt', currentPath, sourcePath,
        beforeHash: await hashFile(currentPath), afterHash: await hashFile(sourcePath), mode: 0o644,
      }],
      deleted: [], conflicts: [],
    };
    await assert.rejects(applyUpdatePlan({
      runId: 'phase5-no-space', projectPath: project, plan,
      diskSpaceProbe: async () => ({ device: 1n, available: 0 }),
    }), (error) => error.code === 'insufficient_disk_space');
    assert.equal(await readFile(currentPath, 'utf8'), 'before\n');
    assert.equal(await exists(path.join(home, 'backups', 'phase5-no-space')), false);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

async function tempDir(prefix = 'zipflow-phase5-') {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
