import { providerDefinition } from './client.js';
import { requestLlmJson } from './json-request.js';

const FALLBACK_CONTEXT = 16_384;

export async function getLocalModelProfile(provider, model, {
  fetchImpl = fetch,
  timeoutMs = 10_000,
  connectionTimeoutMs = null,
  totalDeadlineMs = null,
  idleTimeoutMs = null,
  streamLimits = null,
  apiToken = '',
  signal = null,
} = {}) {
  if (!model) return fallbackProfile(provider, model);
  try {
    if (provider === 'lmstudio') return await lmStudioProfile(model, {
      fetchImpl, timeoutMs, connectionTimeoutMs, totalDeadlineMs, idleTimeoutMs, streamLimits, apiToken, signal,
    });
    if (provider === 'ollama') return await ollamaProfile(model, {
      fetchImpl, timeoutMs, connectionTimeoutMs, totalDeadlineMs, idleTimeoutMs, streamLimits, apiToken, signal,
    });
  } catch (error) {
    if (error?.code === 'cancelled' || error?.code === 'invalid_api_key' || [401, 403].includes(error?.status) || signal?.aborted) throw error;
    return fallbackProfile(provider, model);
  }
  return fallbackProfile(provider, model);
}

export async function listLmStudioModelRecords({
  fetchImpl = fetch,
  timeoutMs = 10_000,
  connectionTimeoutMs = null,
  totalDeadlineMs = null,
  idleTimeoutMs = null,
  streamLimits = null,
  apiToken = '',
  signal = null,
} = {}) {
  const definition = providerDefinition('lmstudio');
  const payload = await requestJson(fetchImpl, `${definition.nativeBaseUrl}/models`, {
    method: 'GET', headers: authHeaders(apiToken),
  }, { provider: 'lmstudio', timeoutMs, connectionTimeoutMs, totalDeadlineMs, idleTimeoutMs, streamLimits, signal });
  return (payload.models ?? []).filter((item) => item.type === 'llm').map((item) => {
    const loadedInstances = (item.loaded_instances ?? []).map((entry) => ({
      id: entry.id,
      contextLength: numberOrNull(entry.config?.context_length),
      config: entry.config ?? {},
    }));
    return {
      key: item.key,
      displayName: item.display_name ?? item.key,
      ids: [...new Set([item.key, ...loadedInstances.map((entry) => entry.id)].filter(Boolean))],
      loadedInstances,
      maxContextLength: numberOrNull(item.max_context_length),
      reasoningOptions: item.capabilities?.reasoning?.allowed_options ?? [],
      reasoningDefault: item.capabilities?.reasoning?.default ?? null,
    };
  });
}

async function lmStudioProfile(model, options) {
  const records = await listLmStudioModelRecords(options);
  const record = findLmStudioRecord(records, model);
  if (!record) return fallbackProfile('lmstudio', model);
  const loaded = chooseLoadedInstance(record, model);
  const contextLength = loaded?.contextLength ?? record.maxContextLength ?? FALLBACK_CONTEXT;
  return {
    provider: 'lmstudio',
    modelKey: record.key,
    contextLength,
    maxContextLength: record.maxContextLength ?? contextLength,
    source: loaded ? 'loaded-instance' : 'model-metadata',
    reasoningOffSupported: record.reasoningOptions.includes('off'),
    requestModel: loaded?.id ?? record.key,
    configuredModel: record.key,
    originalConfiguredModel: model,
    loadedModel: Boolean(loaded),
    loadedInstanceId: loaded?.id ?? null,
    displayName: record.displayName,
  };
}

async function ollamaProfile(model, {
  fetchImpl, timeoutMs, connectionTimeoutMs, totalDeadlineMs, idleTimeoutMs, streamLimits, apiToken, signal,
}) {
  const definition = providerDefinition('ollama');
  const [running, details] = await Promise.all([
    requestJson(fetchImpl, `${definition.nativeBaseUrl}/ps`, {
      method: 'GET', headers: authHeaders(apiToken),
    }, { provider: 'ollama', timeoutMs, connectionTimeoutMs, totalDeadlineMs, idleTimeoutMs, streamLimits, signal })
      .catch(() => ({ models: [] })),
    requestJson(fetchImpl, `${definition.nativeBaseUrl}/show`, {
      method: 'POST', headers: jsonHeaders(apiToken), body: JSON.stringify({ model, verbose: false }),
    }, { provider: 'ollama', timeoutMs, connectionTimeoutMs, totalDeadlineMs, idleTimeoutMs, streamLimits, signal }),
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
    requestModel: model,
    configuredModel: model,
    loadedModel: Boolean(active),
    loadedInstanceId: active?.model ?? active?.name ?? null,
    displayName: model,
  };
}

function findLmStudioRecord(records, model) {
  const exact = records.find((item) => item.key === model || item.loadedInstances.some((entry) => entry.id === model));
  if (exact) return exact;
  return records.find((item) => isLegacyInstanceAlias(model, item.key)) ?? null;
}

function chooseLoadedInstance(record, model) {
  const exact = record.loadedInstances.find((item) => item.id === model);
  if (exact) return exact;
  if (model !== record.key && !isLegacyInstanceAlias(model, record.key)) return null;
  return [...record.loadedInstances].sort((left, right) => (right.contextLength ?? 0) - (left.contextLength ?? 0))[0] ?? null;
}

function isLegacyInstanceAlias(value, modelKey) {
  return Boolean(modelKey) && String(value ?? '').startsWith(`${modelKey}:`);
}

function fallbackProfile(provider, model = '') {
  return {
    provider,
    modelKey: model,
    contextLength: FALLBACK_CONTEXT,
    maxContextLength: FALLBACK_CONTEXT,
    source: 'fallback',
    reasoningOffSupported: false,
    requestModel: model,
    configuredModel: model,
    loadedModel: false,
    loadedInstanceId: null,
    displayName: model,
  };
}

async function requestJson(fetchImpl, url, options, requestOptions) {
  const response = await requestLlmJson(fetchImpl, url, options, requestOptions);
  if (!response.ok) throw metadataResponseError(response);
  return response.payload;
}

function metadataResponseError(response) {
  const details = response.payload?.error ?? response.payload ?? {};
  const error = new Error(details.message || `Local LLM metadata request failed with HTTP ${response.status}.`);
  error.status = response.status;
  error.code = details.code || (response.status === 401 || response.status === 403 ? 'invalid_api_key' : 'metadata_request_failed');
  return error;
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
