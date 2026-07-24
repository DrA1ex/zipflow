import assert from 'node:assert/strict';
import test from 'node:test';
import { Text, renderToString, themes } from 'terlio.js';
import { ZipflowController } from '../src/app/controller.js';
import { createInitialState } from '../src/app/state.js';
import {
  activateUpdateAction,
  checkForUpdatesNow,
  installAvailableUpdate,
  startStartupUpdateCheck,
} from '../src/app/update-flow.js';
import { renderUpdateOverlay } from '../src/ui/update-view.js';

function controllerWith(updateService) {
  const state = createInitialState();
  state.settings = { ...state.settings, theme: 'ocean', interfaceLanguage: 'en' };
  state.i18n = { languageId: 'en' };
  const controller = new ZipflowController(state, { updateService });
  controller.attachRuntime({ invalidate() {}, exit(code) { state.exitCode = code; }, overlays: null });
  return controller;
}

test('startup update check opens a modal only when a newer global npm version exists', async () => {
  const controller = controllerWith({
    check: async () => ({ status: 'available', currentVersion: '1.2.8', latestVersion: '1.3.0' }),
    install: async () => {},
  });

  await startStartupUpdateCheck(controller);

  assert.equal(controller.state.updatePrompt.phase, 'available');
  assert.equal(controller.state.updatePrompt.latestVersion, '1.3.0');
  const output = renderToString(renderUpdateOverlay({
    content: Text('Project screen'), state: controller.state, width: 100, height: 30,
    theme: themes.ocean, animationFrame: 2,
  }), { width: 100, height: 30 });
  assert.match(output, /A newer Zipflow version is available/);
  assert.match(output, /1\.2\.8/);
  assert.match(output, /1\.3\.0/);
  assert.match(output, /Update now/);
});

test('successful automatic update blocks normal workflow until restart or exit', async () => {
  const installs = [];
  const controller = controllerWith({
    check: async () => null,
    install: async (version, options) => {
      installs.push({ version, signal: options.signal });
      options.onOutput?.({ kind: 'stdout', text: 'changed 8 packages\n' });
      return { version };
    },
  });
  controller.state.updatePrompt = {
    phase: 'available', currentVersion: '1.2.8', latestVersion: '1.3.0', selectedIndex: 0,
    installCommand: 'npm install -g zipflow@1.3.0',
  };

  await installAvailableUpdate(controller);

  assert.equal(installs.length, 1);
  assert.equal(installs[0].version, '1.3.0');
  assert.equal(controller.state.activeOperation, null);
  assert.equal(controller.state.updatePrompt.phase, 'complete');
  assert.deepEqual(controller.state.updatePrompt.messageVariables, { version: '1.3.0' });

  await controller.handleKey({ name: 'g', text: 'g', printable: true });
  assert.equal(controller.state.updatePrompt.phase, 'complete', 'global shortcuts stay blocked by the modal');

  await activateUpdateAction(controller, 'update-restart');
  assert.equal(controller.restartRequested, true);
  assert.equal(controller.state.exitCode, 0);
});

test('failed npm install remains inside the update modal and can be dismissed', async () => {
  const controller = controllerWith({
    check: async () => null,
    install: async () => {
      const error = new Error('EACCES: permission denied');
      error.code = 'update-command-failed';
      throw error;
    },
  });
  controller.state.updatePrompt = {
    phase: 'available', currentVersion: '1.2.8', latestVersion: '1.3.0', selectedIndex: 0,
    installCommand: 'npm install -g zipflow@1.3.0',
  };

  await installAvailableUpdate(controller);

  assert.equal(controller.state.updatePrompt.phase, 'failed');
  assert.match(controller.state.updatePrompt.detail, /permission/i);
  assert.equal(controller.state.screen, 'boot');
  assert.equal(controller.recovery, undefined);

  await activateUpdateAction(controller, 'update-later');
  assert.equal(controller.state.updatePrompt, null);
});

test('startup update result does not interrupt an active operation', async () => {
  const controller = controllerWith({
    check: async () => ({ status: 'available', currentVersion: '1.2.8', latestVersion: '1.3.0' }),
    install: async () => {},
  });
  const operation = controller.beginOperation({ kind: 'checks', label: 'Running checks' });
  await startStartupUpdateCheck(controller);
  assert.equal(controller.state.updatePrompt, null);
  assert.equal(controller.state.updateCheck.status, 'available');
  operation.finish();
});

test('disabled automatic checks skip npm without disabling Check now', async () => {
  let checks = 0;
  const controller = controllerWith({
    check: async (options) => {
      checks += 1;
      assert.equal(options?.allowUnsupportedInstallation, true);
      return { status: 'current', currentVersion: '1.3.0', latestVersion: '1.3.0' };
    },
    install: async () => {},
  });
  controller.state.settings.checkForUpdatesOnStartup = false;

  await startStartupUpdateCheck(controller);
  assert.equal(checks, 0);

  controller.state.settingsPanel = { updateChecking: false };
  const toasts = [];
  controller.toast = (...args) => { toasts.push(args); };
  await checkForUpdatesNow(controller);

  assert.equal(checks, 1);
  assert.deepEqual(toasts[0], ['Zipflow is up to date', 'success', 4, 'Latest version: 1.3.0']);
});

test('manual update check opens the update modal when a newer version exists', async () => {
  const controller = controllerWith({
    check: async (options) => {
      assert.equal(options?.allowUnsupportedInstallation, true);
      return {
        status: 'available', currentVersion: '1.3.0', latestVersion: '1.3.1',
        installation: { mode: 'global-npm' }, installSupported: true,
      };
    },
    install: async () => {},
  });
  controller.state.settingsPanel = { updateChecking: false };

  await checkForUpdatesNow(controller);

  assert.equal(controller.state.updatePrompt.phase, 'available');
  assert.equal(controller.state.updatePrompt.latestVersion, '1.3.1');
  assert.equal(controller.state.settingsPanel.updateChecking, false);
});

test('manual source check shows an informational update modal without an install action', async () => {
  const controller = controllerWith({
    check: async () => ({
      status: 'available', currentVersion: '1.3.0', latestVersion: '1.3.1',
      installation: { mode: 'local' }, installSupported: false,
    }),
    install: async () => { throw new Error('must not install'); },
  });
  controller.state.settingsPanel = { updateChecking: false };

  await checkForUpdatesNow(controller);

  assert.equal(controller.state.updatePrompt.installSupported, false);
  const output = renderToString(renderUpdateOverlay({
    content: Text('Settings'), state: controller.state, width: 100, height: 30,
    theme: themes.ocean, animationFrame: 2,
  }), { width: 100, height: 30 });
  assert.match(output, /Automatic installation is available only/);
  assert.doesNotMatch(output, /Update now/);
  assert.match(output, /Close/);

  await activateUpdateAction(controller, 'update-later');
  controller.state.project = { root: '/project', name: 'project', labels: ['Node.js'], workspaceLabels: ['Node.js'], projects: [] };
  controller.state.workflow = null;
  controller.showHome();
  assert.equal(controller.state.menuItems.some((item) => item.id === 'update-zipflow'), false);
});


test('startup update result does not steal focus after the user starts typing', async () => {
  let resolveCheck;
  const controller = controllerWith({
    check: () => new Promise((resolve) => { resolveCheck = resolve; }),
    install: async () => {},
  });
  const checking = startStartupUpdateCheck(controller);
  controller.state.inputGeneration += 1;
  resolveCheck({ status: 'available', currentVersion: '1.2.8', latestVersion: '1.3.0' });
  await checking;

  assert.equal(controller.state.updatePrompt, null);
  assert.equal(controller.state.updateCheck.status, 'available');

  controller.state.project = { root: '/project', name: 'project', labels: ['Node.js'], workspaceLabels: ['Node.js'], projects: [] };
  controller.state.workflow = null;
  controller.showHome();
  assert.ok(controller.state.menuItems.some((item) => item.id === 'update-zipflow'));
  await controller.activateHome('update-zipflow');
  assert.equal(controller.state.updatePrompt.phase, 'available');
});
