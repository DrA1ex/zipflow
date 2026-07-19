const PROVIDERS = {
  ollama: { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'lm-studio' },
};

export function providerDefinition(provider) {
  return PROVIDERS[provider] ?? null;
}

export async function listLocalModels(provider, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const definition = requireProvider(provider);
  const response = await request(fetchImpl, `${definition.baseUrl}/models`, {
    method: 'GET',
    headers: headers(definition),
  }, timeoutMs);
  const payload = await response.json();
  return [...new Set((payload.data ?? []).map((item) => item.id).filter(Boolean))].sort();
}

export async function createLocalCompletion({ provider, model, messages, responseSchema, maxTokens = 700 }, {
  fetchImpl = fetch,
  timeoutMs = 180_000,
} = {}) {
  const definition = requireProvider(provider);
  const body = {
    model,
    messages,
    stream: false,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'zipflow_change_summary', strict: true, schema: responseSchema },
    },
  };
  let response = await request(fetchImpl, `${definition.baseUrl}/chat/completions`, {
    method: 'POST', headers: headers(definition), body: JSON.stringify(body),
  }, timeoutMs, { allowHttpFailure: true });
  if (!response.ok) {
    const firstError = await safeError(response);
    const fallback = { ...body, response_format: { type: 'json_object' } };
    response = await request(fetchImpl, `${definition.baseUrl}/chat/completions`, {
      method: 'POST', headers: headers(definition), body: JSON.stringify(fallback),
    }, timeoutMs, { allowHttpFailure: true });
    if (!response.ok) throw new Error(`${definition.label} request failed: ${await safeError(response) || firstError}`);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error(`${definition.label} returned an empty response.`);
  return content;
}

function requireProvider(provider) {
  const definition = providerDefinition(provider);
  if (!definition) throw new Error('Local LLM provider is not configured.');
  return definition;
}

function headers(definition) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${definition.apiKey}` };
}

async function request(fetchImpl, url, options, timeoutMs, { allowHttpFailure = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!allowHttpFailure && !response.ok) throw new Error(await safeError(response) || `HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Local LLM request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function safeError(response) {
  try {
    const text = await response.text();
    return text.trim().slice(0, 1000);
  } catch {
    return `HTTP ${response.status}`;
  }
}
