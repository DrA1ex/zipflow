import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { applySourceArchivePolicy, clearManagedArchives, inspectManagedArchives } from '../src/archive/disposition.js';
import {
  backupDirectory, clearBackupStorage, inspectBackupStorage, pruneBackupStorage,
} from '../src/apply/backup-storage.js';
import { createBackup } from '../src/apply/backup.js';
import { loadManagedHistory, updateManagedHistory } from '../src/history/managed.js';
import { settingsChoices, settingsDefinitions, settingsParameters } from '../src/app/settings-options.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings/store.js';
import { startHistoricalModelReplay, updateReplayWorkspace } from '../src/app/settings-model-replay.js';
import { showRunDetails } from '../src/app/run-rollback.js';
import { exists, readJson, writeJsonAtomic } from '../src/utils/fs.js';
import { tempDir, writeFiles } from '../test-support/helpers.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

async function withZipflowHome(run) {
  const previous = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-ux-plan-home-');
  try {
    await run(process.env.ZIPFLOW_HOME);
  } finally {
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
  }
}

test('legacy single-language settings migrate to English prompts and the legacy output language', () => {
  const migrated = normalizeSettings({ version: 9, llmLanguage: 'Russian' });
  assert.equal(migrated.llmPromptLanguage, 'English');
  assert.equal(migrated.llmSummaryLanguage, 'Russian');
  assert.equal(migrated.llmCommitLanguage, 'Russian');
  assert.equal(migrated.llmLanguage, 'Russian');

  const explicit = normalizeSettings({
    version: 10,
    llmLanguage: 'Russian',
    llmPromptLanguage: 'German',
    llmSummaryLanguage: 'French',
    llmCommitLanguage: 'English',
  });
  assert.equal(explicit.llmPromptLanguage, 'German');
  assert.equal(explicit.llmSummaryLanguage, 'French');
  assert.equal(explicit.llmCommitLanguage, 'English');
});

test('model test rows distinguish missing selection from an active compatibility test', () => {
  const state = createInitialState();
  state.settings = { ...DEFAULT_SETTINGS, llmProvider: 'ollama', llmModel: '' };
  state.settingsPanel = { subpage: null, modelTest: null, models: [] };
  const definition = settingsDefinitions(state).find((item) => item.id === 'localLlm');
  let parameters = settingsParameters(state, definition);
  let testRow = parameters.find((item) => item.id === 'llmModelTests');
  assert.equal(testRow.disabled, true);
  assert.equal(testRow.disabledReason, 'Choose a model first.');

  state.settings.llmModel = 'qwen';
  state.settingsPanel.subpage = 'llmModelTests';
  state.settingsPanel.modelTest = { running: true, status: 'running' };
  parameters = settingsParameters(state, definition);
  testRow = parameters.find((item) => item.id === 'modelTestConnection');
  assert.equal(testRow.loading, true);
  assert.equal(testRow.disabled, true);
  assert.equal(testRow.label, 'Testing connection…');
  assert.doesNotMatch(testRow.description, /Choose a model first/i);
});

test('historical model replay uses the stored patch and never changes project files', async () => withZipflowHome(async () => {
  const projectRoot = await tempDir('zipflow-replay-project-');
  const patchPath = path.join(await tempDir('zipflow-replay-patch-'), 'changes.patch');
  await writeFiles(projectRoot, { 'src/value.js': 'export const value = 2;\n' });
  await writeFile(patchPath, [
    'diff --git a/src/value.js b/src/value.js',
    '--- a/src/value.js',
    '+++ b/src/value.js',
    '@@ -1 +1 @@',
    '-export const value = 1;',
    '+export const value = 2;',
    '',
  ].join('\n'));
  const before = await readFile(path.join(projectRoot, 'src/value.js'), 'utf8');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      if (url.endsWith('/api/show')) return jsonResponse({
        parameters: 'num_ctx 8192', model_info: { 'fixture.context_length': 8192 },
      });
      if (url.endsWith('/v1/chat/completions')) return jsonResponse({
        choices: [{ message: { content: 'SUMMARY:\n- Historical patch reviewed.\nCOMMIT MESSAGE:\nReview historical patch' } }],
      });
      throw new Error(`Unexpected URL: ${url}`);
    };

    const state = createInitialState();
    state.project = { name: 'fixture', root: projectRoot };
    state.settings = {
      ...DEFAULT_SETTINGS,
      llmProvider: 'ollama', llmModel: 'qwen', llmChangeDelivery: 'patch',
      llmPromptLanguage: 'English', llmSummaryLanguage: 'English', llmCommitLanguage: 'English',
    };
    state.settingsPanel = {
      replayRuns: [{
        id: 'historical-run', archivePath: '/tmp/update.zip', replayAvailable: true,
        patch: { path: patchPath },
        plan: {
          counts: { created: 0, updated: 1, deleted: 0, unchanged: 0, skipped: 0, preserved: 0, conflicts: 0 },
          created: [], updated: ['src/value.js'], deleted: [],
        },
      }],
    };
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};

    const completed = await startHistoricalModelReplay(controller, 'historical-run');

    assert.equal(completed, true);
    assert.equal(await readFile(path.join(projectRoot, 'src/value.js'), 'utf8'), before);
    assert.deepEqual(state.settingsPanel.modelTestWorkspace.result.summary, ['Historical patch reviewed.']);
    assert.ok(state.settingsPanel.modelTestWorkspace.blocks.some((block) => block.id === 'session'));
    assert.ok(state.settingsPanel.modelTestWorkspace.blocks.some((block) => block.id === 'model-profile'));
    assert.ok(state.settingsPanel.modelTestWorkspace.blocks.some((block) => block.id === 'delivery'));
    assert.ok(state.settingsPanel.modelTestWorkspace.blocks.some((block) => block.id === 'parsed-result'));
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

test('historical replay keeps completed batch output when the next batch starts', () => {
  const state = createInitialState();
  state.settingsPanel = { modelTestWorkspace: { blocks: [], status: '', scroll: 0 } };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  updateReplayWorkspace(controller, { type: 'batch-start', index: 1, total: 2, files: ['a.js'] });
  updateReplayWorkspace(controller, { type: 'chunk', content: 'First batch response', reasoning: 'First batch reasoning' });
  updateReplayWorkspace(controller, { type: 'batch-complete', index: 1, total: 2 });
  updateReplayWorkspace(controller, { type: 'batch-start', index: 2, total: 2, files: ['b.js'] });
  updateReplayWorkspace(controller, { type: 'chunk', content: 'Second batch response' });

  const first = state.settingsPanel.modelTestWorkspace.blocks.find((block) => block.id === 'batch-1');
  const second = state.settingsPanel.modelTestWorkspace.blocks.find((block) => block.id === 'batch-2');
  assert.equal(first.content, 'First batch response');
  assert.equal(first.reasoning, 'First batch reasoning');
  assert.equal(first.streaming, false);
  assert.equal(second.content, 'Second batch response');
  assert.equal(second.streaming, true);
});

test('source archive cleanup removes only files registered by Zipflow', async () => withZipflowHome(async () => {
  const sourceRoot = await tempDir('zipflow-source-archive-input-');
  const archiveRoot = await tempDir('zipflow-source-archive-storage-');
  const source = path.join(sourceRoot, 'update.zip');
  const unrelated = path.join(archiveRoot, 'personal.zip');
  await writeFile(source, 'managed archive');
  await writeFile(unrelated, 'unrelated archive');

  const moved = await applySourceArchivePolicy({
    archivePath: source,
    runId: 'run-managed',
    settings: {
      ...DEFAULT_SETTINGS,
      archivePolicy: 'move', archiveDirectory: archiveRoot,
      archiveRetentionDays: 0, archiveMaxBytes: 0,
    },
  });
  let stats = await inspectManagedArchives();
  assert.equal(stats.count, 1);
  assert.equal(await exists(moved.path), true);
  assert.equal(await exists(unrelated), true);

  const cleared = await clearManagedArchives();
  stats = await inspectManagedArchives();
  assert.equal(cleared.removed.length, 1);
  assert.equal(stats.count, 0);
  assert.equal(await exists(moved.path), false);
  assert.equal(await exists(unrelated), true);
}));

test('backup retention removes old backups, protects the active run, and supports safe manual clearing', async () => withZipflowHome(async () => {
  const projectRoot = await tempDir('zipflow-backup-project-');
  const currentPath = path.join(projectRoot, 'file.txt');
  await writeFile(currentPath, 'current');
  const item = { path: 'file.txt', currentPath, kind: 'updated', beforeHash: 'before', afterHash: 'after' };
  await createBackup({ runId: 'old-run', projectPath: projectRoot, items: [item] });
  await createBackup({ runId: 'recent-run', projectPath: projectRoot, items: [item] });
  await createBackup({ runId: 'active-run', projectPath: projectRoot, items: [item] });

  const oldManifestPath = path.join(backupDirectory(), 'old-run', 'manifest.json');
  const oldManifest = await readJson(oldManifestPath, null);
  oldManifest.createdAt = '2025-01-01T00:00:00.000Z';
  await writeJsonAtomic(oldManifestPath, oldManifest);
  const activeManifestPath = path.join(backupDirectory(), 'active-run', 'manifest.json');
  const activeManifest = await readJson(activeManifestPath, null);
  activeManifest.createdAt = '2025-01-01T00:00:00.000Z';
  await writeJsonAtomic(activeManifestPath, activeManifest);

  let stats = await inspectBackupStorage();
  assert.equal(stats.count, 3);
  assert.equal(stats.fileCount, 3);

  const pruned = await pruneBackupStorage({
    ...DEFAULT_SETTINGS,
    backupRetentionPolicy: 'limits', backupRetentionDays: 7, backupMaxBytes: 0,
  }, { activeRunId: 'active-run', now: new Date('2026-07-20T00:00:00.000Z') });
  assert.deepEqual(pruned.removed.map((record) => record.runId), ['old-run']);
  assert.equal(await exists(path.join(backupDirectory(), 'old-run')), false);
  assert.equal(await exists(path.join(backupDirectory(), 'active-run')), true);

  const cleared = await clearBackupStorage({ excludeRunId: 'active-run' });
  assert.deepEqual(cleared.removed.map((record) => record.runId), ['recent-run']);
  assert.equal(await exists(path.join(backupDirectory(), 'active-run', 'manifest.json')), true);
  stats = await inspectBackupStorage();
  assert.deepEqual(stats.records.map((record) => record.runId), ['active-run']);
}));

test('disabling managed-file recording preserves existing history and blocks incompatible workflow settings', async () => withZipflowHome(async () => {
  const projectRoot = await tempDir('zipflow-managed-history-project-');
  await updateManagedHistory(projectRoot, [{ path: 'src/a.js', kind: 'created' }], { enabled: true });
  const result = await updateManagedHistory(projectRoot, [
    { path: 'src/a.js', kind: 'deleted' },
    { path: 'src/b.js', kind: 'created' },
  ], { enabled: false });
  const stored = await loadManagedHistory(projectRoot);
  assert.equal(result.recording, false);
  assert.deepEqual(stored.paths, ['src/a.js']);

  const state = createInitialState();
  state.project = { name: 'fixture', root: projectRoot };
  state.workflow = { deletion: { scope: 'managed-history' } };
  state.settings = { ...DEFAULT_SETTINGS, managedHistoryPolicy: 'record' };
  state.settingsPanel = { managedHistory: stored };
  const definition = settingsDefinitions(state).find((item) => item.id === 'managedHistory');
  const parameter = settingsParameters(state, definition).find((item) => item.id === 'managedHistoryPolicy');
  const choices = settingsChoices(state, parameter);
  const disabled = choices.find((item) => item.value === 'disabled');
  assert.equal(disabled.disabled, true);
  assert.match(disabled.disabledReason, /active workflow uses managed-file history/i);

  state.run = { id: 'active', status: 'checks_passed' };
  const clear = settingsParameters(state, definition).find((item) => item.id === 'managedHistoryClear');
  assert.equal(clear.disabled, true);
  assert.match(clear.disabledReason, /active update/i);
}));

test('run details hide rollback after its backup was removed', () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture' };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  const run = {
    id: 'run-without-backup', projectPath: '/tmp/fixture', status: 'completed',
    archivePath: '/tmp/update.zip', decisions: [],
    plan: {
      counts: { created: 0, updated: 1, deleted: 0, unchanged: 0, skipped: 0, preserved: 0, conflicts: 0 },
      created: [], updated: ['a.js'], deleted: [],
    },
    applied: { backupAvailable: false, backupRemovalReason: 'retention' },
  };

  showRunDetails(controller, run, { origin: 'history' });

  assert.equal(state.menuItems.some((item) => item.id === 'rollback'), false);
  const details = state.messages.find((message) => message.title === 'Run details');
  assert.match(details.lines.join('\n'), /Rollback: unavailable · backup removed \(retention\)/);
});
