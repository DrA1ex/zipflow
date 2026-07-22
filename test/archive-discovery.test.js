import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import yazl from 'yazl';
import { discoverRecentArchives, RECENT_ARCHIVE_MAX_AGE_MS } from '../src/archive/discovery.js';
import { handleEmptyArchiveEnter } from '../src/app/run-archive-discovery.js';

test('recent archive discovery reads ZIP entries without extraction and ranks project matches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-discovery-'));
  const projectRoot = path.join(root, 'project');
  const archiveDir = path.join(root, 'archives');
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  await writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(projectRoot, 'src', 'app.js'), 'export const value = 1;\n');
  const matching = path.join(archiveDir, 'matching.zip');
  const unrelated = path.join(archiveDir, 'unrelated.zip');
  const old = path.join(archiveDir, 'old.zip');
  await createZip(matching, { 'fixture/package.json': '{}', 'fixture/src/app.js': 'changed' });
  await createZip(unrelated, { 'README.md': 'unrelated' });
  await createZip(old, { 'fixture/package.json': '{}' });
  const now = Date.now();
  const oldDate = new Date(now - RECENT_ARCHIVE_MAX_AGE_MS - 60_000);
  await utimes(old, oldDate, oldDate);

  try {
    const found = await discoverRecentArchives({
      directory: archiveDir,
      project: { root: projectRoot, git: false },
      now,
    });
    assert.deepEqual(found.map((item) => item.name), ['matching.zip']);
    assert.equal(found[0].wrapper, 'fixture');
    assert.equal(found[0].exactCount, 2);
    assert.equal(found[0].archiveCoverage, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('empty archive input requires a deliberate double Enter and opens matching candidates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-discovery-input-'));
  const projectRoot = path.join(root, 'project');
  const archiveDir = path.join(root, 'archives');
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  await writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(projectRoot, 'src', 'app.js'), 'export const value = 1;\n');
  await createZip(path.join(archiveDir, 'matching.zip'), {
    'fixture/package.json': '{}',
    'fixture/src/app.js': 'changed',
  });

  const statuses = [];
  const controller = {
    state: {
      screen: 'archive-input',
      editor: { value: '' },
      settings: { lastArchiveDirectory: archiveDir, recentArchivePaths: [] },
      project: { root: projectRoot, git: false },
      archiveDiscoveryTap: null,
      archiveDiscoveryCandidates: [],
      busy: false,
      progress: null,
    },
    setStatus(value) { statuses.push(value); },
    invalidate() {},
    toast() { throw new Error('Discovery unexpectedly failed'); },
    beginOperation() {
      const abort = new AbortController();
      return { signal: abort.signal, finish() {} };
    },
    showMenu(screen, items) {
      this.state.screen = screen;
      this.menuItems = items;
    },
  };

  try {
    assert.equal(await handleEmptyArchiveEnter(controller, { now: 1_000 }), true);
    assert.equal(controller.state.screen, 'archive-input');
    assert.match(statuses.at(-1), /Press Enter again/);

    assert.equal(await handleEmptyArchiveEnter(controller, { now: 1_500 }), true);
    assert.equal(controller.state.screen, 'archive-discovery');
    assert.equal(controller.menuItems.length, 1);
    assert.equal(controller.menuItems[0].label, 'matching.zip');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('empty archive input never guesses a folder when no previous archive was used', async () => {
  let notice = null;
  const controller = {
    state: {
      screen: 'archive-input', editor: { value: '' },
      settings: { lastArchiveDirectory: '', recentArchivePaths: [] },
      project: { root: '/tmp/project' }, archiveDiscoveryTap: null,
    },
    toast(title, level, seconds, details) { notice = { title, level, seconds, details }; },
  };

  assert.equal(await handleEmptyArchiveEnter(controller, { now: 1_000 }), true);
  assert.equal(controller.state.archiveDiscoveryTap, null);
  assert.equal(notice.title, 'No previous archive folder');
});

function createZip(target, files) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
    zip.outputStream.pipe(createWriteStream(target)).on('close', resolve).on('error', reject);
    zip.end();
  });
}
