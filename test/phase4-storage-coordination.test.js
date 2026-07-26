import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireStorageLease, withStorageLease } from '../src/storage/lease.js';
import { ensureActiveRunLease, releaseActiveRunLease, runLeasePath } from '../src/storage/run-leases.js';
import { clearBackupStorage, pruneBackupStorage } from '../src/apply/backup-storage.js';
import { pruneRunHistory } from '../src/runs/store.js';
import { applySourceArchivePolicy, inspectManagedArchives } from '../src/archive/disposition.js';
import {
  assertFullSettingsCas, assertPatchSettingsCas, SettingsConflictError,
} from '../src/settings/revision.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function temporaryHome(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zipflow-phase4-'));
  const previous = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}


function childModule(source, { env = {} } = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`child exited ${code ?? signal}: ${stderr}`)));
  });
  return { child, exited, stderr: () => stderr };
}

async function waitForLine(stream, expected, timeoutMs = 3_000) {
  let text = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}; received ${text}`)), timeoutMs);
    const onData = (chunk) => {
      text += chunk;
      if (!text.includes(expected)) return;
      clearTimeout(timer);
      stream.off('data', onData);
      resolve(text);
    };
    stream.on('data', onData);
  });
}

async function writeBackup(home, runId, createdAt) {
  const directory = path.join(home, 'backups', runId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ runId, createdAt, items: [{ path: 'a' }] }));
  await writeFile(path.join(directory, 'data.bin'), 'backup');
}

async function writeTerminalRun(home, runId, createdAt) {
  const directory = path.join(home, 'runs', runId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ id: runId, status: 'completed', createdAt }));
  await writeFile(path.join(directory, 'report.txt'), 'completed');
}

test('storage lease serializes independent processes', async (t) => {
  const home = await temporaryHome(t);
  const releaseFile = path.join(home, 'release');
  const leaseUrl = pathToFileURL(path.join(root, 'src/storage/lease.js')).href;
  const child = childModule(`
    import { withStorageLease } from ${JSON.stringify(leaseUrl)};
    import { access } from 'node:fs/promises';
    const release = ${JSON.stringify(releaseFile)};
    await withStorageLease('shared-test', async () => {
      process.stdout.write('locked\\n');
      while (true) { try { await access(release); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
    });
  `, { env: { ZIPFLOW_HOME: home } });
  await waitForLine(child.child.stdout, 'locked');

  let acquired = false;
  const waiting = withStorageLease('shared-test', async () => { acquired = true; }, { waitMs: 2_000, pollMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(acquired, false);
  await writeFile(releaseFile, 'release');
  await child.exited;
  await waiting;
  assert.equal(acquired, true);
});

test('settings CAS merges unrelated stale patches and rejects lost updates', () => {
  const base = { storageRevision: 4, theme: 'ocean', interfaceLanguage: 'en' };
  const current = { storageRevision: 5, theme: 'matrix', interfaceLanguage: 'en' };
  const unrelatedPatch = { interfaceLanguage: 'ru' };
  assert.doesNotThrow(() => assertPatchSettingsCas(current, unrelatedPatch, base));
  assert.deepEqual({ ...current, ...unrelatedPatch }, {
    storageRevision: 5, theme: 'matrix', interfaceLanguage: 'ru',
  });
  assert.throws(
    () => assertPatchSettingsCas(current, { theme: 'mono' }, base),
    (error) => error instanceof SettingsConflictError && error.code === 'settings_conflict',
  );
  assert.throws(() => assertPatchSettingsCas(current, { llmApiToken: 'replacement' }, base), /changed in another Zipflow instance/i);
  assert.throws(() => assertFullSettingsCas(base, current), /changed in another Zipflow instance/i);
  assert.throws(() => assertFullSettingsCas({ theme: 'mono' }, current), /changed in another Zipflow instance/i);
  assert.doesNotThrow(() => assertFullSettingsCas({ theme: 'mono' }, { storageRevision: 0 }, { currentExists: false }));
});


test('stale storage leases are reclaimed while active leases remain static', async (t) => {
  const home = await temporaryHome(t);
  const stalePath = path.join(home, 'leases', 'storage', 'stale.lease');
  await mkdir(path.dirname(stalePath), { recursive: true });
  await writeFile(stalePath, JSON.stringify({
    version: 2, name: 'stale', pid: process.pid, ownerToken: 'old-owner',
    createdAt: '2020-01-01T00:00:00.000Z',
  }));
  const lease = await acquireStorageLease('stale', {
    path: stalePath,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    isProcessAlive: () => true,
    staleAfterMs: 1_000,
    waitMs: 0,
  });
  assert.notEqual(lease.ownerToken, 'old-owner');
  const leaseBytes = await readFile(lease.path, 'utf8');
  await lease.heartbeat();
  assert.equal(await readFile(lease.path, 'utf8'), leaseBytes);
  await lease.release();

  const malformedPath = path.join(home, 'leases', 'storage', 'malformed.lease');
  await writeFile(malformedPath, '{');
  const malformed = await acquireStorageLease('malformed', { path: malformedPath, waitMs: 0 });
  assert.ok(malformed.ownerToken);
  await malformed.release();

  const original = await acquireStorageLease('static-owner', { waitMs: 0 });
  await assert.rejects(
    acquireStorageLease('static-owner', { waitMs: 0, isProcessAlive: () => true }),
    (error) => error?.code === 'storage_busy',
  );
  await original.release();

  const active = await ensureActiveRunLease('static-run');
  const first = await readFile(active.path, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(await readFile(active.path, 'utf8'), first);
  await releaseActiveRunLease('static-run');
});

test('another process active-run lease protects its backup from prune and clear', async (t) => {
  const home = await temporaryHome(t);
  const old = '2020-01-01T00:00:00.000Z';
  await writeBackup(home, 'active-backup', old);
  await writeBackup(home, 'inactive-backup', old);
  const leaseUrl = pathToFileURL(path.join(root, 'src/storage/run-leases.js')).href;
  const releaseFile = path.join(home, 'release-active-backup');
  const child = childModule(`
    import { ensureActiveRunLease, releaseActiveRunLease } from ${JSON.stringify(leaseUrl)};
    import { access } from 'node:fs/promises';
    await ensureActiveRunLease('active-backup');
    process.stdout.write('leased\\n');
    while (true) { try { await access(${JSON.stringify(releaseFile)}); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
    await releaseActiveRunLease('active-backup');
  `, { env: { ZIPFLOW_HOME: home } });
  t.after(() => { if (child.child.exitCode === null) child.child.kill('SIGKILL'); });
  await waitForLine(child.child.stdout, 'leased');

  const pruned = await pruneBackupStorage({
    backupRetentionPolicy: 'limits', backupRetentionDays: 1, backupMaxBytes: 1,
  }, { now: new Date('2026-01-01T00:00:00.000Z') });
  assert.deepEqual(pruned.removed.map((record) => record.runId), ['inactive-backup']);
  assert.equal(await readFile(path.join(home, 'backups/active-backup/manifest.json'), 'utf8').then(() => true, () => false), true);

  const cleared = await clearBackupStorage();
  assert.equal(cleared.removed.length, 0);
  assert.equal(await readFile(path.join(home, 'backups/active-backup/manifest.json'), 'utf8').then(() => true, () => false), true);
  await writeFile(releaseFile, 'release');
  await child.exited;
});

test('another process active-run lease protects terminal run history from pruning', async (t) => {
  const home = await temporaryHome(t);
  const old = '2020-01-01T00:00:00.000Z';
  await writeTerminalRun(home, 'active-run', old);
  await writeTerminalRun(home, 'inactive-run', old);
  const leaseUrl = pathToFileURL(path.join(root, 'src/storage/run-leases.js')).href;
  const releaseFile = path.join(home, 'release-active-run');
  const child = childModule(`
    import { ensureActiveRunLease, releaseActiveRunLease } from ${JSON.stringify(leaseUrl)};
    import { access } from 'node:fs/promises';
    await ensureActiveRunLease('active-run');
    process.stdout.write('leased\\n');
    while (true) { try { await access(${JSON.stringify(releaseFile)}); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
    await releaseActiveRunLease('active-run');
  `, { env: { ZIPFLOW_HOME: home } });
  t.after(() => { if (child.child.exitCode === null) child.child.kill('SIGKILL'); });
  await waitForLine(child.child.stdout, 'leased');

  const result = await pruneRunHistory({ retentionDays: 1, maxBytes: 1, now: Date.parse('2026-01-01T00:00:00Z') });
  assert.deepEqual(result.removed, ['inactive-run']);
  assert.equal(await readFile(path.join(home, 'runs/active-run/report.json'), 'utf8').then(() => true, () => false), true);
  await writeFile(releaseFile, 'release');
  await child.exited;
});

test('concurrent archive moves preserve both records and destinations', async (t) => {
  const home = await temporaryHome(t);
  const archiveDirectory = path.join(home, 'managed');
  const sourceA = path.join(home, 'source-a', 'update.zip');
  const sourceB = path.join(home, 'source-b', 'update.zip');
  await mkdir(path.dirname(sourceA), { recursive: true });
  await mkdir(path.dirname(sourceB), { recursive: true });
  await writeFile(sourceA, 'archive-a');
  await writeFile(sourceB, 'archive-b');
  const moduleUrl = pathToFileURL(path.join(root, 'src/archive/disposition.js')).href;
  const source = (archivePath, runId) => `
    import { applySourceArchivePolicy } from ${JSON.stringify(moduleUrl)};
    await applySourceArchivePolicy({
      archivePath: ${JSON.stringify(archivePath)}, runId: ${JSON.stringify(runId)},
      settings: { archivePolicy: 'move', archiveDirectory: ${JSON.stringify(archiveDirectory)}, archiveRetentionDays: 30, archiveMaxBytes: 1000000 },
    });
  `;
  const first = childModule(source(sourceA, 'run-a'), { env: { ZIPFLOW_HOME: home } });
  const second = childModule(source(sourceB, 'run-b'), { env: { ZIPFLOW_HOME: home } });
  await Promise.all([first.exited, second.exited]);

  const storage = await inspectManagedArchives();
  assert.equal(storage.count, 2);
  assert.deepEqual(new Set(storage.records.map((record) => record.runId)), new Set(['run-a', 'run-b']));
  assert.equal(new Set(storage.records.map((record) => record.path)).size, 2);
});

test('run lease paths cannot collide after filename sanitization', async (t) => {
  const home = await temporaryHome(t);
  assert.notEqual(runLeasePath('a/b'), runLeasePath('a_b'));
});
