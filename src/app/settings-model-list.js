import { listLocalModelChoices, providerDefinition } from '../llm/client.js';
import { saveSettings } from '../settings/store.js';

export async function refreshModels(controller, { quiet = false } = {}) {
  const { state } = controller;
  const provider = state.settings.llmProvider;
  if (provider === 'disabled') return;
  const panel = state.settingsPanel;
  if (panel.loadingModels) return;
  panel.loadingModels = true;
  panel.modelRefreshFrame = 0;
  panel.modelError = null;
  controller.invalidate();
  const spinnerTimer = setInterval(() => {
    if (!panel.loadingModels) return;
    panel.modelRefreshFrame = (panel.modelRefreshFrame + 1) % 10_000;
    controller.invalidate();
  }, 120);
  spinnerTimer.unref?.();
  try {
    panel.models = await listLocalModelChoices(provider, { apiToken: state.settings.llmApiToken });
    panel.modelsProvider = provider;
    const current = findConfiguredModel(panel.models, state.settings.llmModel);
    if (current && current.id !== state.settings.llmModel) {
      state.settings = await saveSettings({ ...state.settings, llmModel: current.id, llmDecisionCompatibility: null });
    } else if (!current && state.settings.llmModel) {
      state.settings = await saveSettings({ ...state.settings, llmModel: '', llmDecisionCompatibility: null });
    }
    if (!quiet) {
      state.status = 'Local LLM';
      controller.toast(`${panel.models.length} ${providerDefinition(provider).label} models available`, 'success');
    }
  } catch (error) {
    panel.models = [];
    panel.modelsProvider = provider;
    panel.modelError = error.message;
    if (!quiet) {
      state.status = 'Model refresh failed';
      controller.toast('Model refresh failed', 'error', 3, error.message);
    }
  } finally {
    clearInterval(spinnerTimer);
    panel.loadingModels = false;
    panel.modelRefreshFrame = 0;
    controller.invalidate();
  }
}

export async function ensureDefinitionData(controller, definition) {
  if (definition.id === 'localLlm') await ensureModels(controller);
}

export async function ensureModels(controller) {
  const { state } = controller;
  const panel = state.settingsPanel;
  if (state.settings.llmProvider !== 'disabled'
    && panel.modelsProvider !== state.settings.llmProvider
    && !panel.loadingModels) await refreshModels(controller, { quiet: true });
}

export function resetModelCache(panel) {
  panel.models = [];
  panel.modelsProvider = null;
  panel.modelError = null;
}


function findConfiguredModel(models, configuredModel) {
  return models.find((item) => item.id === configuredModel || item.key === configuredModel)
    ?? models.find((item) => item.loadedInstanceIds?.includes(configuredModel))
    ?? models.find((item) => String(configuredModel ?? '').startsWith(`${item.key}:`))
    ?? null;
}
