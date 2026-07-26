import { formatInstallCommand } from '../update/service.js';
import { translateForState as t } from '../i18n/index.js';

export async function startStartupUpdateCheck(controller) {
  if (process.env.ZIPFLOW_DISABLE_UPDATE_CHECK === '1'
    || controller.state.settings?.checkForUpdatesOnStartup === false
    || controller.state.updatePrompt) return null;
  const inputGeneration = controller.state.inputGeneration;
  let result;
  try {
    result = await controller.updateService.check();
  } catch {
    return null;
  }
  controller.state.updateCheck = result;
  if (result?.status !== 'available' || controller.state.screen === 'error'
    || controller.state.activeOperation || controller.state.busy
    || controller.state.inputGeneration !== inputGeneration) return result;
  showAvailableUpdate(controller, result);
  return result;
}

export async function checkForUpdatesNow(controller) {
  const panel = controller.state.settingsPanel;
  if (panel?.updateChecking || controller.state.updatePrompt) return null;
  if (panel) panel.updateChecking = true;
  controller.invalidate();
  let result;
  try {
    result = await controller.updateService.check({ allowUnsupportedInstallation: true });
    controller.state.updateCheck = result;
    if (result?.status === 'available') {
      showAvailableUpdate(controller, result);
      return result;
    }
    if (result?.status === 'current') {
      controller.toast('Zipflow is up to date', 'success', 4, t(controller.state, 'Latest version: {version}', { version: result.latestVersion }));
      return result;
    }
    controller.toast('Could not check for updates', 'warning', 4, result?.error?.message ?? 'The npm registry did not return a usable version.');
    return result;
  } catch (error) {
    controller.toast('Could not check for updates', 'warning', 4, error.message);
    return null;
  } finally {
    if (controller.state.settingsPanel) controller.state.settingsPanel.updateChecking = false;
    controller.invalidate();
  }
}

export function showAvailableUpdate(controller, result = controller.state.updateCheck) {
  if (!result || result.status !== 'available') return false;
  const installSupported = result.installSupported !== undefined
    ? Boolean(result.installSupported)
    : !result.installation?.mode || result.installation.mode === 'global-npm';
  controller.state.updatePrompt = {
    phase: 'available',
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    installSupported,
    selectedIndex: 0,
    message: '',
    detail: '',
    cancelling: false,
    installCommand: formatInstallCommand(result.latestVersion),
    installation: result.installation ?? null,
    verification: null,
  };
  controller.invalidate();
  return true;
}

export async function handleUpdateKey(controller, key) {
  const prompt = controller.state.updatePrompt;
  if (!prompt) return false;
  if (key.name === 'up' || key.name === 'down') {
    moveUpdateSelection(prompt, key.name === 'up' ? -1 : 1);
    controller.invalidate();
    return true;
  }
  if (key.name === 'escape') {
    if (prompt.phase === 'installing') await cancelUpdate(controller);
    else if (prompt.phase === 'complete' || prompt.phase === 'uncertain') controller.exit(0);
    else closeUpdatePrompt(controller);
    return true;
  }
  if (key.name === 'enter' || key.name === 'space') {
    await activateUpdateAction(controller, updateActions(prompt)[prompt.selectedIndex]?.id);
    return true;
  }
  return true;
}

export async function handleUpdateDispatch(controller, action) {
  if (!controller.state.updatePrompt) return false;
  if (action.type === 'update-move') {
    moveUpdateSelection(controller.state.updatePrompt, Number(action.delta) || 0);
    controller.invalidate();
    return true;
  }
  if (action.type === 'update-select') {
    const actions = updateActions(controller.state.updatePrompt);
    const index = Math.max(0, Math.min(actions.length - 1, Math.trunc(Number(action.index) || 0)));
    if (!actions[index]?.disabled) controller.state.updatePrompt.selectedIndex = index;
    controller.invalidate();
    return true;
  }
  if (action.type === 'update-activate') {
    await activateUpdateAction(controller, action.id);
    return true;
  }
  return false;
}

export function updateActions(prompt) {
  if (!prompt) return [];
  if (prompt.phase === 'available') return prompt.installSupported === false
    ? [{ id: 'update-later', label: 'Close', description: 'Close this message and continue using the current installation.' }]
    : [
      { id: 'update-now', label: 'Update now', description: 'Install the available version globally with npm.' },
      { id: 'update-later', label: 'Later', description: 'Keep using the current version and ask again on a future startup.' },
    ];
  if (prompt.phase === 'installing') return [
    { id: 'update-cancel', label: prompt.cancelling ? 'Cancelling update…' : 'Cancel update', description: 'Stop the active npm installation.', disabled: prompt.cancelling },
  ];
  if (prompt.phase === 'failed') return [
    { id: 'update-retry', label: 'Try again', description: `Run ${prompt.installCommand}` },
    { id: 'update-later', label: 'Later', description: 'Close this message and continue with the current version.' },
  ];
  if (prompt.phase === 'uncertain') return [
    { id: 'update-exit', label: 'Exit Zipflow', description: 'Close this process. Verify or reinstall Zipflow before starting it again.' },
  ];
  if (prompt.phase === 'complete') return [
    { id: 'update-restart', label: 'Restart Zipflow', description: 'Restart Zipflow now using the installed version.' },
    { id: 'update-exit', label: 'Exit', description: 'Close Zipflow and start it yourself later.' },
  ];
  return [];
}

export async function activateUpdateAction(controller, itemId) {
  if (!itemId) return;
  if (itemId === 'update-later') return closeUpdatePrompt(controller);
  if (itemId === 'update-now' || itemId === 'update-retry') return installAvailableUpdate(controller);
  if (itemId === 'update-cancel') return cancelUpdate(controller);
  if (itemId === 'update-restart') return controller.requestRestart();
  if (itemId === 'update-exit') return controller.exit(0);
}

export async function installAvailableUpdate(controller) {
  const prompt = controller.state.updatePrompt;
  if (!prompt || !prompt.latestVersion || prompt.phase === 'installing' || prompt.installSupported === false) return;
  const operation = controller.beginOperation({
    kind: 'self-update',
    label: 'Installing Zipflow update',
    cancellable: true,
  });
  Object.assign(prompt, {
    phase: 'installing', selectedIndex: 0, message: 'Installing the update with npm…', messageVariables: {},
    detail: prompt.installCommand, cancelling: false, verification: null,
  });
  controller.invalidate();
  let installError = null;
  let verification = null;
  operation.enterCritical('Replacing the global npm package');
  try {
    try {
      await controller.updateService.install(prompt.latestVersion, {
        signal: operation.signal,
        onOutput: ({ text }) => {
          const line = String(text ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
          if (line) prompt.detail = line;
          controller.invalidate();
        },
      });
    } catch (error) {
      installError = error;
    }
    prompt.message = 'Verifying the installed Zipflow package…';
    prompt.detail = 'Checking package metadata, executable presence, and zipflow --version.';
    controller.invalidate();
    verification = typeof controller.updateService.verify === 'function'
      ? await controller.updateService.verify({
        previousVersion: prompt.currentVersion,
        targetVersion: prompt.latestVersion,
        installation: prompt.installation,
      }).catch((error) => ({ status: 'uncertain', detail: error.message }))
      : { status: installError ? 'unchanged' : 'updated' };
    prompt.verification = verification;
  } finally {
    const cancellationRequested = operation.isCancellationRequested();
    operation.leaveCritical('Update verification complete');
    applyUpdateVerification(prompt, verification, installError, { cancellationRequested });
    operation.finish(updateOperationOutcome(prompt));
    controller.invalidate();
  }
}

export async function cancelUpdate(controller) {
  const prompt = controller.state.updatePrompt;
  if (!prompt || prompt.phase !== 'installing' || prompt.cancelling) return;
  prompt.cancelling = true;
  prompt.message = 'Cancelling the npm installation…';
  controller.invalidate();
  await controller.handleInterrupt();
}

export function closeUpdatePrompt(controller, { force = false } = {}) {
  if (controller.state.updatePrompt?.phase === 'uncertain' && !force) return false;
  controller.state.updatePrompt = null;
  controller.invalidate();
}

function moveUpdateSelection(prompt, delta) {
  const actions = updateActions(prompt);
  if (!actions.length) return;
  let index = prompt.selectedIndex;
  for (let attempts = 0; attempts < actions.length; attempts += 1) {
    index = (index + delta + actions.length) % actions.length;
    if (!actions[index]?.disabled) {
      prompt.selectedIndex = index;
      return;
    }
  }
}

function applyUpdateVerification(prompt, verification, installError, { cancellationRequested = false } = {}) {
  if (verification?.status === 'updated') {
    Object.assign(prompt, {
      phase: 'complete', selectedIndex: 0, message: 'Zipflow {version} was installed.',
      messageVariables: { version: prompt.latestVersion },
      detail: 'The installed package and executable both report the requested version. Restart Zipflow before continuing.',
      cancelling: false,
    });
    return;
  }
  if (verification?.status === 'unchanged') {
    if (cancellationRequested || installError?.code === 'cancelled') {
      Object.assign(prompt, {
        phase: 'available', selectedIndex: 0, message: 'Update cancelled.', messageVariables: {},
        detail: 'The installed package and executable still report the previous version.', cancelling: false,
      });
      return;
    }
    Object.assign(prompt, {
      phase: 'failed', selectedIndex: 0, message: 'Automatic update failed.', messageVariables: {},
      detail: updateFailureMessage(installError ?? new Error('npm finished without replacing the installed Zipflow version.')),
      cancelling: false,
    });
    return;
  }
  Object.assign(prompt, {
    phase: 'uncertain', selectedIndex: 0, message: 'Zipflow installation state is uncertain.', messageVariables: {},
    detail: verification?.detail || updateFailureMessage(installError ?? new Error('The installed package could not be verified.')),
    cancelling: false,
  });
}

function updateOperationOutcome(prompt) {
  if (prompt.phase === 'complete') return 'completed';
  if (prompt.phase === 'available' && prompt.message === 'Update cancelled.') return 'cancelled';
  return 'failed';
}

function updateFailureMessage(error) {
  const source = String(error?.message ?? 'Unknown npm error.').trim();
  if (/EACCES|permission denied/i.test(source)) {
    return 'npm does not have permission to replace the global package. Fix the npm global install permissions or use a user-owned Node installation, then try again.';
  }
  return source;
}
