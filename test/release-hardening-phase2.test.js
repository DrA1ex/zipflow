import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import {
  detectBinary, trustedPathDirectories, validateBinaryPath,
} from '../src/security/binaries.js';
import {
  createProjectCommandEnvironment, PROJECT_ENVIRONMENT_NOTICE_VERSION,
} from '../src/security/environment.js';
import {
  createCommit, createInitialCommit, prepareInitialCommit, runGit,
} from '../src/git/repository.js';
import { createRecommendedWorkflow, normalizeWorkflow, WORKFLOW_VERSION } from '../src/workflow/defaults.js';
import {
  FULL_AUTOPILOT_WARNING_VERSION, autonomyForMode, fullAutopilotWarningAcknowledged, fullAutopilotWarningRequired,
} from '../src/autonomy/policies.js';
import { activateAutonomy } from '../src/app/setup-autonomy.js';
import { settingsChoices, settingsFieldDefinition, settingsParameters } from '../src/app/settings-options.js';
import { gitHooksSettingAvailable } from '../src/git/hooks.js';
import { normalizeSettings, SETTINGS_VERSION } from '../src/settings/store.js';
import { runDeploy } from '../src/deploy/runner.js';
import { checkForUpdate } from '../src/update/service.js';

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function executable(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { mode: 0o755 });
  await chmod(target, 0o755);
  return target;
}

async function findOnPath(name) {
  for (const directory of trustedPathDirectories(process.env.PATH)) {
    const target = path.join(directory, name);
    try {
      await access(target, fsConstants.X_OK);
      return target;
    } catch {}
  }
  return null;
}

async function initializeGit(root) {
  await runGit(root, ['init']);
  await runGit(root, ['config', 'user.name', 'Zipflow Test']);
  await runGit(root, ['config', 'user.email', 'zipflow@example.invalid']);
}

test('internal binary detection ignores project-local node_modules/.bin and validates identity probes', async (t) => {
  const root = await temporaryDirectory('zipflow-phase2-binary-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const localBin = path.join(root, 'node_modules', '.bin');
  const projectBin = path.join(root, 'bin');
  const fakeGit = await executable(path.join(localBin, 'git'), '#!/bin/sh\necho git version 9.9.9-manual\n');
  const projectGit = await executable(path.join(projectBin, 'git'), '#!/bin/sh\necho project-intercepted\n');
  const realGit = await findOnPath('git');
  assert.ok(realGit, 'Git is required for the phase-2 test');

  const detected = await detectBinary('git', {
    env: { PATH: `${localBin}${path.delimiter}${projectBin}${path.delimiter}${path.dirname(realGit)}` },
    cwd: root,
  });
  assert.equal(detected.valid, true);
  assert.notEqual(detected.resolvedPath, fakeGit);
  assert.notEqual(detected.resolvedPath, projectGit);
  assert.equal(path.dirname(detected.resolvedPath), path.dirname(await import('node:fs/promises').then(({ realpath }) => realpath(realGit))));

  assert.equal(detected.excludedPaths.some((item) => item.path === localBin), true);
  assert.equal(detected.excludedPaths.some((item) => item.path === projectBin), true);
  const manualLocal = await validateBinaryPath('git', fakeGit);
  assert.equal(manualLocal.valid, true);
  assert.match(manualLocal.warning, /manual override.*node_modules\/\.bin/i);
  const wrongIdentity = await executable(path.join(root, 'trusted', 'git'), '#!/bin/sh\necho definitely-not-git\n');
  await assert.rejects(validateBinaryPath('git', wrongIdentity), /probe failed/);

  const npmViaEnv = await executable(path.join(root, 'trusted', 'npm'), '#!/usr/bin/env node\nconsole.log("10.9.0");\n');
  const npmStatus = await validateBinaryPath('npm', npmViaEnv);
  assert.equal(npmStatus.valid, true);
  assert.equal(npmStatus.version, '10.9.0');
});



test('Binaries settings expose resolved status, path completion metadata, and all required actions', () => {
  const state = {
    settings: { binaryPaths: { git: '/usr/bin/git' } },
    settingsPanel: {
      loadingBinaries: false,
      binaries: {
        git: {
          mode: 'manual', valid: true, resolvedPath: '/usr/bin/git', version: 'git version 2.44.0',
        },
      },
      detectedBinaries: {
        git: { valid: true, resolvedPath: '/opt/homebrew/bin/git' },
      },
    },
  };
  const parameters = settingsParameters(state, { id: 'binaries' });
  const git = parameters.find((item) => item.binaryId === 'git');
  assert.equal(git.value, 'Manual · Validated');
  assert.match(git.description, /\/usr\/bin\/git/);
  assert.match(git.description, /git version 2\.44\.0/);
  assert.deepEqual(settingsChoices(state, git).map((item) => item.action), [
    'binary-use-detected', 'binary-choose-path', 'binary-reset-auto', 'binary-test',
  ]);
  const field = settingsFieldDefinition('binaryPath:git');
  assert.equal(field.path, true);
  assert.equal(field.directoriesOnly, false);
  assert.match(field.instructions.join('\n'), /Shift\+Tab moves to the parent directory/);
});

test('sanitized project environment keeps ordinary execution context and removes secrets and agent sockets', () => {
  const projectPath = path.join(os.tmpdir(), 'zipflow-project');
  const baseEnv = {
    PATH: '/usr/bin:/bin', HOME: '/home/user', LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    TMPDIR: '/tmp', USER: 'user', SHELL: '/bin/sh', CI: '1',
    AWS_SECRET_ACCESS_KEY: 'secret', NPM_TOKEN: 'token', SSH_AUTH_SOCK: '/tmp/agent.sock',
    GPG_AGENT_INFO: '/tmp/gpg', CUSTOM_SECRET: 'hidden',
  };
  const sanitized = createProjectCommandEnvironment('sanitized', { baseEnv, projectPath, cwd: projectPath });
  assert.equal(sanitized.HOME, baseEnv.HOME);
  assert.equal(sanitized.LANG, baseEnv.LANG);
  assert.equal(sanitized.ZIPFLOW_PROJECT_ROOT, projectPath);
  assert.equal(sanitized.ZIPFLOW_COMMAND_ENVIRONMENT, 'sanitized');
  assert.equal(sanitized.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(sanitized.NPM_TOKEN, undefined);
  assert.equal(sanitized.SSH_AUTH_SOCK, undefined);
  assert.equal(sanitized.CUSTOM_SECRET, undefined);
  assert.ok(sanitized.PATH.startsWith(path.join(projectPath, 'node_modules', '.bin')));

  const inherited = createProjectCommandEnvironment('inherit', { baseEnv, projectPath, cwd: projectPath });
  assert.equal(inherited.AWS_SECRET_ACCESS_KEY, 'secret');
  assert.equal(inherited.SSH_AUTH_SOCK, '/tmp/agent.sock');
});


test('project deployment commands receive the configured environment policy end to end', async (t) => {
  const root = await temporaryDirectory('zipflow-phase2-deploy-env-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'print-env.mjs');
  await writeFile(script, `console.log(JSON.stringify({ secret: process.env.ZIPFLOW_PHASE2_SECRET ?? null, root: process.env.ZIPFLOW_PROJECT_ROOT ?? null, policy: process.env.ZIPFLOW_COMMAND_ENVIRONMENT ?? null, cwd: process.cwd() }));\n`);
  const previous = process.env.ZIPFLOW_PHASE2_SECRET;
  process.env.ZIPFLOW_PHASE2_SECRET = 'must-not-leak';
  t.after(() => {
    if (previous === undefined) delete process.env.ZIPFLOW_PHASE2_SECRET;
    else process.env.ZIPFLOW_PHASE2_SECRET = previous;
  });
  const commandText = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
  const projectBin = path.join(root, 'node_modules', '.bin');
  await executable(path.join(projectBin, 'zipflow-env-probe'), `#!/bin/sh
printf '%s\n' "$PWD"
`);
  const sanitized = await runDeploy({
    deploy: { commandText, cwd: '.' }, projectPath: root,
    settings: { deployCommandEnvironment: 'sanitized' },
  });
  assert.equal(sanitized.ok, true, sanitized.stderr);
  const sanitizedPayload = JSON.parse(sanitized.stdout.trim());
  assert.equal(sanitizedPayload.secret, null);
  assert.equal(sanitizedPayload.root, root);
  assert.equal(sanitizedPayload.policy, 'sanitized');
  assert.equal(await realpath(sanitizedPayload.cwd), await realpath(root));
  const projectTool = await runDeploy({
    deploy: { commandText: 'zipflow-env-probe', cwd: '.' }, projectPath: root,
    settings: { deployCommandEnvironment: 'sanitized' },
  });
  assert.equal(projectTool.ok, true, projectTool.stderr);
  assert.equal(await realpath(projectTool.stdout.trim()), await realpath(root));

  const inherited = await runDeploy({
    deploy: { commandText, cwd: '.' }, projectPath: root,
    settings: { deployCommandEnvironment: 'inherit' },
  });
  assert.equal(inherited.ok, true, inherited.stderr);
  const inheritedPayload = JSON.parse(inherited.stdout.trim());
  assert.equal(inheritedPayload.secret, 'must-not-leak');
  assert.equal(inheritedPayload.policy, null);
});

test('self-update commands use the resolved trusted npm executable', async () => {
  const calls = [];
  const result = await checkForUpdate({
    currentVersion: '1.3.2',
    detectInstallation: async () => ({ mode: 'global-npm' }),
    resolveBinary: async (toolId) => {
      assert.equal(toolId, 'npm');
      return '/trusted/system/npm';
    },
    run: async (command, args) => {
      calls.push({ command, args });
      return { ok: true, code: 0, stdout: '"1.3.3"\n', stderr: '' };
    },
  });
  assert.equal(result.status, 'available');
  assert.deepEqual(calls.map((call) => call.command), ['/trusted/system/npm']);
});

test('automatic Zipflow commits bypass hostile project hooks unless the configured workflow opts in', async (t) => {
  const root = await temporaryDirectory('zipflow-phase2-hooks-');
  const home = await temporaryDirectory('zipflow-phase2-home-');
  const previousHome = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]);
  });

  await initializeGit(root);
  await writeFile(path.join(root, 'app.txt'), 'baseline\n');
  await runGit(root, ['add', '--', 'app.txt']);
  await runGit(root, ['commit', '-m', 'baseline']);

  const preMarker = path.join(root, 'pre-hook-ran.txt');
  const postMarker = path.join(root, 'post-hook-ran.txt');
  await executable(path.join(root, '.git', 'hooks', 'pre-commit'), `#!/bin/sh
printf pre > ${JSON.stringify(preMarker)}
exit 91
`);
  await executable(path.join(root, '.git', 'hooks', 'post-commit'), `#!/bin/sh
printf post > ${JSON.stringify(postMarker)}
`);

  await writeFile(path.join(root, 'app.txt'), 'safe commit\n');
  const safe = await createCommit(root, ['app.txt'], 'zipflow safe commit', { allowHooks: false });
  assert.equal(safe.ok, true, safe.reason);
  await assert.rejects(readFile(preMarker), /ENOENT/);
  await assert.rejects(readFile(postMarker), /ENOENT/);
  const persistedHooksPath = await runGit(root, ['config', '--local', '--get', 'core.hooksPath'], { allowFailure: true });
  assert.equal(persistedHooksPath.code, 1);
  assert.equal(persistedHooksPath.stdout.trim(), '');

  await writeFile(path.join(root, 'app.txt'), 'hooked commit fails\n');
  const blocked = await createCommit(root, ['app.txt'], 'zipflow hooked commit', { allowHooks: true });
  assert.equal(blocked.ok, false);
  assert.equal(await readFile(preMarker, 'utf8'), 'pre');
  await assert.rejects(readFile(postMarker), /ENOENT/);

  await rm(preMarker, { force: true });
  await executable(path.join(root, '.git', 'hooks', 'pre-commit'), `#!/bin/sh
printf pre > ${JSON.stringify(preMarker)}
`);
  await writeFile(path.join(root, 'app.txt'), 'hooked commit succeeds\n');
  const optedIn = await createCommit(root, ['app.txt'], 'zipflow hooked commit', { allowHooks: true });
  assert.equal(optedIn.ok, true, optedIn.reason);
  assert.equal(await readFile(preMarker, 'utf8'), 'pre');
  assert.equal(await readFile(postMarker, 'utf8'), 'post');
});

test('initial Git baseline enumerates candidates, excludes protected paths, and never silently commits flagged secrets', async (t) => {
  const root = await temporaryDirectory('zipflow-phase2-initial-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeGit(root);
  await mkdir(path.join(root, '.zipflow'), { recursive: true });
  await writeFile(path.join(root, 'app.js'), 'console.log("safe");\n');
  await writeFile(path.join(root, '.env'), 'TOKEN=secret\n');
  await writeFile(path.join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n');
  await writeFile(path.join(root, 'id_rsa'), 'PRIVATE KEY\n');
  await writeFile(path.join(root, 'server.pem'), 'PRIVATE KEY\n');
  await writeFile(path.join(root, '.zipflow', 'state.json'), '{}\n');

  const prepared = await prepareInitialCommit(root);
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.paths.sort(), ['.env', '.npmrc', 'app.js', 'id_rsa', 'server.pem']);
  assert.deepEqual(prepared.approvedPaths, ['app.js']);
  assert.deepEqual(prepared.sensitive.map((item) => item.path).sort(), ['.env', '.npmrc', 'id_rsa', 'server.pem']);

  const committed = await createInitialCommit(root, 'Initial commit');
  assert.equal(committed.ok, true, committed.reason);
  assert.deepEqual(committed.paths, ['app.js']);
  const tree = await runGit(root, ['ls-tree', '-r', '--name-only', 'HEAD']);
  assert.deepEqual(tree.stdout.trim().split(/\r?\n/), ['app.js']);
  const status = await runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  assert.match(status.stdout, /\?\? \.env/);
  assert.match(status.stdout, /\?\? \.npmrc/);
  assert.match(status.stdout, /\?\? id_rsa/);
  assert.match(status.stdout, /\?\? server\.pem/);
  assert.match(status.stdout, /\?\? \.zipflow\/state\.json/);
});

test('workflow and settings migration use safe Phase-2 defaults', () => {
  const project = { name: 'demo', root: '/tmp/demo', checks: [], technologies: [], labels: [] };
  const workflow = createRecommendedWorkflow(project);
  assert.equal(WORKFLOW_VERSION, 9);
  assert.equal(workflow.git.hooks, 'disabled');
  const migrated = normalizeWorkflow({ ...workflow, version: 8, git: { checkpoint: 'ask', resultCommit: 'auto' } });
  assert.equal(migrated.git.hooks, 'disabled');

  const settings = normalizeSettings({ version: 20, binaryPaths: { git: '/usr/bin/git', unknown: '/tmp/tool' } });
  assert.equal(SETTINGS_VERSION, 23);
  assert.equal(settings.checkCommandEnvironment, 'sanitized');
  assert.equal(settings.deployCommandEnvironment, 'inherit');
  assert.equal(settings.projectCommandEnvironment, undefined);
  assert.equal(settings.projectEnvironmentNoticeVersion, 0);
  assert.deepEqual(settings.binaryPaths, { git: '/usr/bin/git' });
  assert.equal(PROJECT_ENVIRONMENT_NOTICE_VERSION, 1);
  const legacyEnvironment = normalizeSettings({ version: 22, projectCommandEnvironment: 'sanitized' });
  assert.equal(legacyEnvironment.checkCommandEnvironment, 'sanitized');
  assert.equal(legacyEnvironment.deployCommandEnvironment, 'sanitized');
});



test('Git hook setting is available only while editing an already configured workflow', () => {
  assert.equal(gitHooksSettingAvailable({ setupEditing: false, setupSection: 'git' }), false);
  assert.equal(gitHooksSettingAvailable({ setupEditing: true, setupSection: null }), false);
  assert.equal(gitHooksSettingAvailable({ setupEditing: true, setupSection: 'git' }), true);
});

test('Full autopilot warning acknowledgement is versioned and persisted in the workflow draft', () => {
  const full = autonomyForMode('full');
  assert.equal(full.fullWarningAcknowledgedVersion, 0);
  assert.equal(fullAutopilotWarningAcknowledged({ autonomy: full }), false);
  assert.equal(fullAutopilotWarningRequired({ autonomy: full }), true);

  const state = {
    draft: { autonomy: autonomyForMode('manual') },
    settings: {
      llmProvider: 'ollama', llmModel: 'model',
      llmDecisionCompatibility: { supported: true, provider: 'ollama', model: 'model' },
    },
    setupEditing: true,
  };
  const controller = {
    state,
    showMenu(screen, items, title, selectedIndex, context = []) {
      state.screen = screen;
      state.menuItems = items;
      state.title = title;
      state.selectedIndex = selectedIndex;
      state.context = context;
    },
  };
  activateAutonomy(controller, 'autonomy-full', () => {});
  assert.equal(state.screen, 'setup-autonomy-confirm');
  assert.match(state.context.join('\n'), /untrusted decision input/i);
  assert.match(state.context.join('\n'), /model can misunderstand/i);
  assert.match(state.context.join('\n'), /Deterministic checks/i);

  activateAutonomy(controller, 'autonomy-full-confirm', () => {});
  assert.equal(state.draft.autonomy.mode, 'full');
  assert.equal(state.draft.autonomy.fullWarningAcknowledgedVersion, FULL_AUTOPILOT_WARNING_VERSION);
  assert.equal(fullAutopilotWarningAcknowledged(state.draft), true);
  assert.equal(fullAutopilotWarningRequired(state.draft), false);
});


function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}
