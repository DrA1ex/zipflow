import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NPM_REGISTRY,
  checkForUpdate,
  compareVersions,
  formatInstallCommand,
  installUpdate,
} from '../src/update/service.js';

test('semantic version comparison handles stable and prerelease versions', () => {
  assert.equal(compareVersions('1.3.0', '1.2.8'), 1);
  assert.equal(compareVersions('1.2.8', '1.2.8'), 0);
  assert.equal(compareVersions('1.2.8-beta.2', '1.2.8-beta.1'), 1);
  assert.equal(compareVersions('1.2.8', '1.2.8-beta.9'), 1);
  assert.equal(compareVersions('1.2.7', '1.2.8'), -1);
});

test('update check reads the latest dist-tag from the official npm registry', async () => {
  const calls = [];
  const result = await checkForUpdate({
    currentVersion: '1.2.8',
    detectInstallation: async () => ({ mode: 'global-npm' }),
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { ok: true, code: 0, stdout: '"1.3.0"\n', stderr: '' };
    },
  });

  assert.equal(result.status, 'available');
  assert.equal(result.latestVersion, '1.3.0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'npm');
  assert.deepEqual(calls[0].args.slice(0, 4), ['view', 'zipflow@latest', 'version', '--json']);
  assert.ok(calls[0].args.includes(`--registry=${NPM_REGISTRY}`));
  assert.ok(calls[0].args.includes('--fetch-retries=0'));
});

test('update check stays silent for local and linked source installations', async () => {
  let called = false;
  const result = await checkForUpdate({
    detectInstallation: async () => ({ mode: 'linked' }),
    run: async () => { called = true; throw new Error('should not run'); },
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(called, false);
});

test('manual update checks still read the latest version for a local source installation', async () => {
  let called = false;
  const result = await checkForUpdate({
    currentVersion: '1.3.0',
    allowUnsupportedInstallation: true,
    detectInstallation: async () => ({ mode: 'local' }),
    run: async () => {
      called = true;
      return { ok: true, code: 0, stdout: '"1.3.1"\n', stderr: '' };
    },
  });

  assert.equal(called, true);
  assert.equal(result.status, 'available');
  assert.equal(result.latestVersion, '1.3.1');
  assert.equal(result.installSupported, false);
});

test('automatic update installs one validated version globally without a shell', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const result = await installUpdate('1.3.0', {
    signal,
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.version, '1.3.0');
  assert.equal(result.command, formatInstallCommand('1.3.0'));
  assert.equal(calls[0].command, 'npm');
  assert.deepEqual(calls[0].args.slice(0, 3), ['install', '-g', 'zipflow@1.3.0']);
  assert.ok(calls[0].args.includes(`--registry=${NPM_REGISTRY}`));
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.shell, undefined);
});

test('automatic update rejects untrusted version strings before spawning npm', async () => {
  let called = false;
  await assert.rejects(
    installUpdate('1.3.0; rm -rf /', { run: async () => { called = true; } }),
    /Invalid Zipflow update version/,
  );
  assert.equal(called, false);
});

test('semantic version comparison is exact for build metadata and large numeric identifiers', () => {
  assert.equal(compareVersions('1.2.3+build.9', '1.2.3+build.1'), 0);
  assert.equal(compareVersions('900719925474099300000.0.0', '900719925474099299999.9.9'), 1);
  assert.equal(compareVersions('1.0.0-alpha.900719925474099300000', '1.0.0-alpha.900719925474099299999'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
});

test('invalid registry versions never reach npm installation commands', async () => {
  for (const version of ['01.2.3', '1.02.3', '1.2.03', '1.0.0-alpha.01', '1.0', 'latest', '1.0.0+bad..build']) {
    let called = false;
    await assert.rejects(
      installUpdate(version, { run: async () => { called = true; } }),
      /Invalid Zipflow update version/,
    );
    assert.equal(called, false, version);
  }

  let installCalled = false;
  const result = await checkForUpdate({
    currentVersion: '1.3.1',
    detectInstallation: async () => ({ mode: 'global-npm' }),
    run: async () => ({ ok: true, code: 0, stdout: '"1.3.2; echo unsafe"', stderr: '' }),
  });
  assert.equal(result.status, 'unavailable');
  await assert.rejects(
    installUpdate(result.latestVersion, { run: async () => { installCalled = true; } }),
    /Invalid Zipflow update version/,
  );
  assert.equal(installCalled, false);
});
