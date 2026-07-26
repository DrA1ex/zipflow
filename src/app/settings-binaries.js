import {
  BINARY_TOOL_IDS,
  clearBinaryResolutionCache,
  detectBinary,
  inspectAllBinaries,
  inspectBinary,
  validateBinaryPath,
} from '../security/binaries.js';
import { updateSettings } from '../settings/store.js';

export async function refreshSettingsBinaries(controller, { quiet = false } = {}) {
  const { state } = controller;
  const panel = state.settingsPanel;
  if (!panel || panel.loadingBinaries) return panel?.binaries ?? {};
  panel.loadingBinaries = true;
  panel.binaryError = null;
  if (!quiet) state.status = 'Checking configured binaries';
  controller.invalidate();
  try {
    clearBinaryResolutionCache();
    const [binaries, detectedEntries] = await Promise.all([
      inspectAllBinaries({ settings: state.settings, refresh: true }),
      Promise.all(BINARY_TOOL_IDS.map(async (toolId) => [toolId, await detectBinary(toolId)])),
    ]);
    panel.binaries = binaries;
    panel.detectedBinaries = Object.fromEntries(detectedEntries);
    return binaries;
  } catch (error) {
    panel.binaryError = error.message;
    if (!quiet) controller.toast(error.message, 'error');
    return panel.binaries ?? {};
  } finally {
    panel.loadingBinaries = false;
    if (!quiet) state.status = 'Binaries';
    controller.invalidate();
  }
}

export async function useDetectedBinary(controller, toolId) {
  const { state } = controller;
  const detected = state.settingsPanel?.detectedBinaries?.[toolId] ?? await detectBinary(toolId);
  if (!detected.valid || !detected.resolvedPath) throw new Error(detected.error || 'No validated system executable was detected.');
  const binaryPaths = { ...(state.settings.binaryPaths ?? {}), [toolId]: detected.resolvedPath };
  state.settings = await updateSettings({ binaryPaths }, { baseSettings: state.settings });
  await refreshSettingsBinaries(controller, { quiet: true });
  return detected;
}

export async function resetBinaryToAutomatic(controller, toolId) {
  const { state } = controller;
  const binaryPaths = { ...(state.settings.binaryPaths ?? {}) };
  delete binaryPaths[toolId];
  state.settings = await updateSettings({ binaryPaths }, { baseSettings: state.settings });
  await refreshSettingsBinaries(controller, { quiet: true });
  return state.settingsPanel?.binaries?.[toolId] ?? null;
}

export async function testConfiguredBinary(controller, toolId) {
  clearBinaryResolutionCache();
  const result = await inspectBinary(toolId, { settings: controller.state.settings, refresh: true });
  controller.state.settingsPanel.binaries[toolId] = result;
  controller.invalidate();
  if (!result.valid) throw new Error(result.error || `${result.label} validation failed.`);
  return result;
}

export async function saveBinaryPath(controller, toolId, entered) {
  const validated = await validateBinaryPath(toolId, entered);
  const { state } = controller;
  const binaryPaths = { ...(state.settings.binaryPaths ?? {}), [toolId]: validated.configuredPath };
  state.settings = await updateSettings({ binaryPaths }, { baseSettings: state.settings });
  await refreshSettingsBinaries(controller, { quiet: true });
  return validated;
}
