import { listLocalModelChoices, providerDefinition } from '../llm/client.js';
import { saveSettings } from '../settings/store.js';

export async function refreshModels(controller, { quiet = false } = {}) {
  const { state } = controller;
  const provider = state.settings.llmProvider;
  if (provider === 'disabled') return;
  const panel = state.settingsPanel;
  panel.loadingModels = true;
  panel.modelError = null;
  controller.invalidate();
  try {
    panel.models = await listLocalModelChoices(provider, { apiToken: state.settings.llmApiToken });
    panel.modelsProvider = provider;
    const current = panel.models.find((item) => item.id === state.settings.llmModel)
      ?? panel.models.find((item) => item.key === state.settings.llmModel);
    if (current && current.id !== state.settings.llmModel) {
      state.settings = await saveSettings({ ...state.settings, llmModel: current.id });
    } else if (!current && state.settings.llmModel) {
      state.settings = await saveSettings({ ...state.settings, llmModel: '' });
    }
    if (!quiet) state.status = `${panel.models.length} ${providerDefinition(provider).label} models available`;
  } catch (error) {
    panel.models = [];
    panel.modelsProvider = provider;
    panel.modelError = error.message;
    if (!quiet) state.status = error.message;
  } finally {
    panel.loadingModels = false;
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
