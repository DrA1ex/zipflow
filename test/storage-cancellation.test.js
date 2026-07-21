import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { clearBackupStorage } from '../src/apply/backup-storage.js';
import { archiveIndexPath, clearManagedArchives } from '../src/archive/disposition.js';
import { tempDir } from '../test-support/helpers.js';

async function makeBackup(home, runId) {
  const root = path.join(home, 'backups', runId);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    version: 1, runId, createdAt: new Date().toISOString(), items: [],
  }));
  await writeFile(path.join(root, 'payload.txt'), runId);
  return root;
}

test('backup cleanup reports and preserves a consistent partial result when Ctrl+C arrives between records', async () => {
  const home = await tempDir('zipflow-storage-cancel-home-');
  process.env.ZIPFLOW_HOME = home;
  try {
    await makeBackup(home, 'run-a');
    await makeBackup(home, 'run-b');
    const abortController = new AbortController();
    const result = await clearBackupStorage({
      signal: abortController.signal,
      onProgress: ({ removed }) => { if (removed === 1) abortController.abort('cancelled'); },
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.removed.length, 1);
    assert.equal(result.failed.length, 0);
    const remaining = ['run-a', 'run-b'].filter((runId) => !result.removed.some((item) => item.runId === runId));
    assert.equal(remaining.length, 1);
    assert.equal(await readFile(path.join(home, 'backups', remaining[0], 'manifest.json'), 'utf8').then(() => true), true);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

test('source archive cleanup saves the remaining index when cancellation arrives after a deletion', async () => {
  const home = await tempDir('zipflow-archive-clean-cancel-home-');
  const files = await tempDir('zipflow-archive-clean-cancel-files-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const records = [];
    for (const name of ['a.zip', 'b.zip']) {
      const target = path.join(files, name);
      await writeFile(target, name);
      records.push({ path: target, originalPath: target, runId: `run-${name}`, addedAt: new Date().toISOString(), size: name.length });
    }
    await mkdir(path.dirname(archiveIndexPath()), { recursive: true });
    await writeFile(archiveIndexPath(), JSON.stringify({ version: 1, records }));
    const abortController = new AbortController();
    const result = await clearManagedArchives({
      signal: abortController.signal,
      onProgress: ({ removed }) => { if (removed === 1) abortController.abort('cancelled'); },
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.removed.length, 1);
    const index = JSON.parse(await readFile(archiveIndexPath(), 'utf8'));
    assert.equal(index.records.length, 1);
    assert.notEqual(index.records[0].path, result.removed[0].path);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});
