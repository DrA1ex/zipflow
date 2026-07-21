import { getLocalModelProfile } from './model-info.js';

export async function resolveLocalLlmSession(settings, {
  fetchImpl = fetch,
  timeoutMs = 10_000,
  signal = null,
} = {}) {
  const apiToken = String(settings?.llmApiToken ?? '').trim();
  const preferredModel = settings.llmProvider === 'lmstudio' && settings.llmSelectedInstanceId
    ? settings.llmSelectedInstanceId
    : settings.llmModel;
  let profile = await getLocalModelProfile(settings.llmProvider, preferredModel, {
    fetchImpl,
    timeoutMs,
    apiToken,
    signal,
  });
  if (settings.llmProvider === 'lmstudio' && preferredModel !== settings.llmModel && profile.source === 'fallback') {
    profile = await getLocalModelProfile(settings.llmProvider, settings.llmModel, {
      fetchImpl,
      timeoutMs,
      apiToken,
      signal,
    });
  }
  applyConfiguredContext(settings, profile);
  return {
    provider: settings.llmProvider,
    configuredModel: profile.modelKey || settings.llmModel,
    apiToken,
    profile,
  };
}

function applyConfiguredContext(settings, profile) {
  const key = `${settings.llmProvider}:${profile.modelKey || settings.llmModel}`;
  const configured = Number(settings.llmModelLoadConfigs?.[key]?.contextLength);
  if (!Number.isInteger(configured) || configured <= 0) return;
  profile.contextLength = profile.maxContextLength
    ? Math.min(configured, profile.maxContextLength)
    : configured;
  profile.source = 'zipflow-settings';
}
