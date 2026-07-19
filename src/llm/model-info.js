import { providerDefinition } from './client.js';

const FALLBACK_CONTEXT = 16_384;

export async function getLocalModelProfile(provider, model, {
  fetchImpl = fetch,
  timeoutMs = 10_000,
  apiToken = '',
} = {}) {
  if (!model) return fallbackProfile(provider);
  try {
    if (provider === 'lmstudio') return await lmStudioProfile(model, { fetchImpl, timeoutMs, apiToken });
    if (provider === 'ollama') return await ollamaProfile(model, { fetchImpl, timeoutMs, apiToken });
  } catch {
    return fallbackProfile(provider);
  }
  return fallbackProfile(provider);
}

export async function listLmStudioModelRecords({ fetchImpl = fetch, timeoutMs = 10_000, apiToken = '' } = {}) {
  const definition = providerDefinition('lmstudio');
  const payload = await requestJson(fetchImpl, `${definition.nativeBaseUrl}/models`, {
    method: 'GET', headers: authHeaders(apiToken),
  }, timeoutMs);
  return (payload.models ?? []).filter((item) => item.type === 'llm').map((item) => {
    const loaded = item.loaded_instances ?? [];
    return {
      key: item.key,
      ids: [...new Set([item.key, ...loaded.map((entry) => entry.id)].filter(Boolean))],
      contextLength: maxNumber(loaded.map((entry) => entry.config?.context_length)),
      maxContextLength: numberOrNull(item.max_context_length),
      reasoningOptions: item.capabilities?.reasoning?.allowed_options ?? [],
      reasoningDefault: item.capabilities?.reasoning?.default ?? null,
    };
  });
}

async function lmStudioProfile(model, options) {
  const records = await listLmStudioModelRecords(options);
  const record = records.find((item) => item.ids.includes(model) || item.key === model);
  if (!record) return fallbackProfile('lmstudio');
  const contextLength = record.contextLength ?? record.maxContextLength ?? FALLBACK_CONTEXT;
  return {
    provider: 'lmstudio',
    contextLength,
    maxContextLength: record.maxContextLength ?? contextLength,
    source: record.contextLength ? 'loaded-instance' : 'model-metadata',
    reasoningOffSupported: record.reasoningOptions.includes('off'),
  };
}

async function ollamaProfile(model, { fetchImpl, timeoutMs, apiToken }) {
  const definition = providerDefinition('ollama');
  const [running, details] = await Promise.all([
    requestJson(fetchImpl, `${definition.nativeBaseUrl}/ps`, {
      method: 'GET', headers: authHeaders(apiToken),
    }, timeoutMs).catch(() => ({ models: [] })),
    requestJson(fetchImpl, `${definition.nativeBaseUrl}/show`, {
      method: 'POST', headers: jsonHeaders(apiToken), body: JSON.stringify({ model, verbose: false }),
    }, timeoutMs),
  ]);
  const active = (running.models ?? []).find((item) => item.model === model || item.name === model);
  const configured = parseNumCtx(details.parameters);
  const maximum = maxNumber(Object.entries(details.model_info ?? {})
    .filter(([key]) => key.endsWith('.context_length'))
    .map(([, value]) => value));
  const contextLength = numberOrNull(active?.context_length) ?? configured ?? Math.min(maximum ?? FALLBACK_CONTEXT, 4_096);
  return {
    provider: 'ollama',
    contextLength,
    maxContextLength: maximum ?? contextLength,
    source: active?.context_length ? 'running-model' : configured ? 'model-parameters' : maximum ? 'conservative-default' : 'fallback',
    reasoningOffSupported: true,
  };
}

function fallbackProfile(provider) {
  return {
    provider,
    contextLength: FALLBACK_CONTEXT,
    maxContextLength: FALLBACK_CONTEXT,
    source: 'fallback',
    reasoningOffSupported: false,
  };
}

async function requestJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(apiToken) {
  const headers = {};
  if (String(apiToken ?? '').trim()) headers.Authorization = `Bearer ${String(apiToken).trim()}`;
  return headers;
}

function jsonHeaders(apiToken) {
  return { 'Content-Type': 'application/json', ...authHeaders(apiToken) };
}

function parseNumCtx(parameters) {
  const match = String(parameters ?? '').match(/(?:^|\n)\s*num_ctx\s+(\d+)/i);
  return match ? numberOrNull(match[1]) : null;
}

function maxNumber(values) {
  const numbers = values.map(numberOrNull).filter((value) => value !== null);
  return numbers.length ? Math.max(...numbers) : null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}
