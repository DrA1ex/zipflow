import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { createOverlayManager, renderToString } from 'terlio.js';
import { createInitialState } from '../src/app/state.js';
import { renderZipflow } from '../src/ui/render.js';
import {
  credentialsPath, DEFAULT_SETTINGS, loadSettings, settingsBackupPath, settingsPath, updateSettings,
} from '../src/settings/store.js';
import {
  resetCredentialBackendForTests, SecureCredentialStoreError, setCredentialBackendForTests,
} from '../src/security/credential-store.js';
import { ensureZipflowHome, getZipflowHome } from '../src/workflow/store.js';
import { exists, readJson, writeJsonAtomic } from '../src/utils/fs.js';
import { tempDir } from '../test-support/helpers.js';

async function withHome(prefix, run) {
  const previous = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = await tempDir(prefix);
  try {
    await run();
  } finally {
    resetCredentialBackendForTests();
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
  }
}

function memoryCredentialBackend() {
  let token = '';
  return {
    async read() { return token; },
    async write(_identity, value) { token = value; },
    async delete() { token = ''; },
  };
}

test('ordinary workflow menus render with the intended description layout', () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture' };
  state.workflow = { policy: { label: 'Practical' }, checks: [] };
  state.screen = 'home';
  state.menuItems = [{ id: 'start-update', label: 'Start update', description: 'Choose an archive.' }];
  state.overlays = createOverlayManager();
  const output = renderToString(renderZipflow({ state, width: 100, height: 28 }), { width: 100, height: 28 });
  assert.match(output, /Start update/);
  assert.match(output, /Choose an archive/);
});

test('legacy plaintext credentials migrate to the secure store and are scrubbed', async () => withHome('zipflow-credential-migration-', async () => {
  setCredentialBackendForTests(memoryCredentialBackend());
  await ensureZipflowHome();
  await writeFile(settingsPath(), `${JSON.stringify({ ...DEFAULT_SETTINGS, llmApiToken: 'legacy-secret', theme: 'mono' })}\n`);
  await writeFile(settingsBackupPath(), `${JSON.stringify({ ...DEFAULT_SETTINGS, llmApiToken: 'legacy-secret' })}\n`);
  await writeFile(credentialsPath(), `${JSON.stringify({ version: 1, llmApiToken: 'legacy-secret' })}\n`);

  const loaded = await loadSettings();
  assert.equal(loaded.llmApiToken, 'legacy-secret');
  assert.equal(await exists(credentialsPath()), false);
  assert.equal(Object.prototype.hasOwnProperty.call(await readJson(settingsPath()), 'llmApiToken'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(await readJson(settingsBackupPath()), 'llmApiToken'), false);
}));


test('a valid primary settings file does not resurrect a stale token from its backup', async () => withHome('zipflow-stale-token-backup-', async () => {
  setCredentialBackendForTests(memoryCredentialBackend());
  await ensureZipflowHome();
  await writeFile(settingsPath(), `${JSON.stringify({ ...DEFAULT_SETTINGS, theme: 'mono' })}\n`);
  await writeFile(settingsBackupPath(), `${JSON.stringify({ ...DEFAULT_SETTINGS, llmApiToken: 'stale-secret' })}\n`);
  await writeFile(credentialsPath(), `${JSON.stringify({ version: 1, llmApiToken: '' })}\n`);

  const loaded = await loadSettings();
  assert.equal(loaded.llmApiToken, '');
  assert.doesNotMatch(await readFile(settingsBackupPath(), 'utf8'), /stale-secret|llmApiToken/);
  assert.equal(await exists(credentialsPath()), false);
}));

test('a legacy backup token is recovered when no explicit clear marker exists', async () => withHome('zipflow-token-backup-recovery-', async () => {
  const backend = memoryCredentialBackend();
  setCredentialBackendForTests(backend);
  await ensureZipflowHome();
  await writeFile(settingsPath(), `${JSON.stringify({ ...DEFAULT_SETTINGS, theme: 'mono' })}\n`);
  await writeFile(settingsBackupPath(), `${JSON.stringify({ ...DEFAULT_SETTINGS, llmApiToken: 'backup-secret' })}\n`);

  const loaded = await loadSettings();
  assert.equal(loaded.llmApiToken, 'backup-secret');
  assert.equal(await backend.read(), 'backup-secret');
  assert.equal(Object.prototype.hasOwnProperty.call(await readJson(settingsPath()), 'llmApiToken'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(await readJson(settingsBackupPath()), 'llmApiToken'), false);
}));

test('unrelated settings changes preserve an unmigrated legacy token when the keyring is unavailable', async () => withHome('zipflow-token-preserve-unavailable-', async () => {
  const unavailableError = () => new SecureCredentialStoreError(
    'Secure credential storage is unavailable. The token was not written to disk.',
    { code: 'credential-store-unavailable' },
  );
  setCredentialBackendForTests({
    async read() { throw unavailableError(); },
    async write() { throw unavailableError(); },
    async delete() { throw unavailableError(); },
  });
  await ensureZipflowHome();
  await writeFile(settingsPath(), `${JSON.stringify({ ...DEFAULT_SETTINGS, llmApiToken: 'legacy-only-copy' })}\n`);

  const updated = await updateSettings({ theme: 'mono' });
  assert.equal(updated.llmApiToken, 'legacy-only-copy');
  assert.equal((await readJson(settingsPath())).llmApiToken, 'legacy-only-copy');
}));

test('an unavailable secure store refuses a new token without creating plaintext fallback', async () => withHome('zipflow-credential-unavailable-', async () => {
  setCredentialBackendForTests({
    async read() { return ''; },
    async write() {
      throw new SecureCredentialStoreError('Secure credential storage is unavailable. The token was not written to disk.', {
        code: 'credential-store-unavailable',
      });
    },
    async delete() {},
  });
  await assert.rejects(
    updateSettings({ llmApiToken: 'must-not-leak' }, { allowClearToken: true }),
    /not written to disk/,
  );
  assert.equal(await exists(credentialsPath()), false);
  if (await exists(settingsPath())) assert.doesNotMatch(await readFile(settingsPath(), 'utf8'), /must-not-leak/);
}));

test('Zipflow state directories and atomically written settings are owner-only', async () => withHome('zipflow-private-mode-', async () => {
  setCredentialBackendForTests(memoryCredentialBackend());
  await ensureZipflowHome();
  await chmod(getZipflowHome(), 0o755);
  await ensureZipflowHome();
  await updateSettings({ theme: 'mono' });
  assert.equal((await stat(getZipflowHome())).mode & 0o777, 0o700);
  assert.equal((await stat(settingsPath())).mode & 0o777, 0o600);
}));

test('concurrent atomic writes use distinct temporary paths and leave valid JSON', async () => withHome('zipflow-atomic-write-', async () => {
  await ensureZipflowHome();
  const originalNow = Date.now;
  Date.now = () => 123456789;
  try {
    await Promise.all([
      writeJsonAtomic(settingsPath(), { writer: 'first' }),
      writeJsonAtomic(settingsPath(), { writer: 'second' }),
    ]);
  } finally {
    Date.now = originalNow;
  }
  assert.match((await readJson(settingsPath())).writer, /^(?:first|second)$/);
}));
