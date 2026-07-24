import { formatInstallCommand } from '../update/service.js';

export async function startStartupUpdateCheck(controller) {
  if (process.env.ZIPFLOW_DISABLE_UPDATE_CHECK === '1' || controller.state.updatePrompt) return null;
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

export function showAvailableUpdate(controller, result = controller.state.updateCheck) {
  if (!result || result.status !== 'available') return false;
  controller.state.updatePrompt = {
    phase: 'available',
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    selectedIndex: 0,
    message: '',
    detail: '',
    cancelling: false,
    installCommand: formatInstallCommand(result.latestVersion),
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
    else if (prompt.phase === 'complete') controller.exit(0);
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
    moveUpdateSelection(controller.state.updatePrompt, Math.sign(Number(action.delta) || 0));
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
  if (prompt.phase === 'available') return [
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
  if (!prompt || !prompt.latestVersion || prompt.phase === 'installing') return;
  const operation = controller.beginOperation({
    kind: 'self-update',
    label: 'Installing Zipflow update',
    cancellable: true,
  });
  Object.assign(prompt, {
    phase: 'installing', selectedIndex: 0, message: 'Installing the update with npm…', messageVariables: {},
    detail: prompt.installCommand, cancelling: false,
  });
  controller.invalidate();
  try {
    await controller.updateService.install(prompt.latestVersion, {
      signal: operation.signal,
      onOutput: ({ text }) => {
        const line = String(text ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
        if (line) prompt.detail = line;
        controller.invalidate();
      },
    });
    Object.assign(prompt, {
      phase: 'complete', selectedIndex: 0, message: 'Zipflow {version} was installed.',
      messageVariables: { version: prompt.latestVersion }, detail: 'Restart Zipflow before continuing so the running process uses the new files.', cancelling: false,
    });
  } catch (error) {
    if (error?.code === 'cancelled' || operation.signal.aborted) {
      Object.assign(prompt, {
        phase: 'available', selectedIndex: 0, message: 'Update cancelled.', messageVariables: {},
        detail: '', cancelling: false,
      });
    } else {
      Object.assign(prompt, {
        phase: 'failed', selectedIndex: 0, message: 'Automatic update failed.', messageVariables: {},
        detail: updateFailureMessage(error), cancelling: false,
      });
    }
  } finally {
    operation.finish();
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

export function closeUpdatePrompt(controller) {
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

function updateFailureMessage(error) {
  const source = String(error?.message ?? 'Unknown npm error.').trim();
  if (/EACCES|permission denied/i.test(source)) {
    return 'npm does not have permission to replace the global package. Fix the npm global install permissions or use a user-owned Node installation, then try again.';
  }
  return source;
}
