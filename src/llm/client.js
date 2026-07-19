const PROVIDERS = {
  ollama: { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
};

export function providerDefinition(provider) {
  return PROVIDERS[provider] ?? null;
}

export async function listLocalModels(provider, {
  fetchImpl = fetch,
  timeoutMs = 10_000,
  apiToken = '',
} = {}) {
  const definition = requireProvider(provider);
  const response = await request(fetchImpl, `${definition.baseUrl}/models`, {
    method: 'GET',
    headers: headers(apiToken),
  }, timeoutMs);
  const payload = await response.json();
  return [...new Set((payload.data ?? []).map((item) => item.id).filter(Boolean))].sort();
}

export async function createLocalCompletion({
  provider,
  model,
  messages,
  responseSchema,
  maxTokens = 2_048,
  apiToken = '',
}, {
  fetchImpl = fetch,
  timeoutMs = 600_000,
  onEvent = () => {},
} = {}) {
  const definition = requireProvider(provider);
  const common = {
    model,
    messages,
    stream: true,
    temperature: 0,
    max_tokens: maxTokens,
  };
  const attempts = [
    {
      ...common,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'zipflow_change_summary', strict: true, schema: responseSchema },
      },
    },
    { ...common, response_format: { type: 'json_object' } },
  ];
  let firstError = '';
  for (let index = 0; index < attempts.length; index += 1) {
    onEvent({ type: 'request', attempt: index + 1, format: index === 0 ? 'json_schema' : 'json_object' });
    const response = await request(fetchImpl, `${definition.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(apiToken),
      body: JSON.stringify(attempts[index]),
    }, timeoutMs, { allowHttpFailure: true });
    if (!response.ok) {
      const error = await safeError(response);
      if (!firstError) firstError = error;
      if (index === attempts.length - 1) throw new Error(`${definition.label} request failed: ${error || firstError}`);
      onEvent({ type: 'retry', reason: error || `HTTP ${response.status}` });
      continue;
    }
    return readCompletionResponse(response, { onEvent });
  }
  throw new Error(`${definition.label} request failed: ${firstError || 'unknown error'}`);
}

function requireProvider(provider) {
  const definition = providerDefinition(provider);
  if (!definition) throw new Error('Local LLM provider is not configured.');
  return definition;
}

function headers(apiToken) {
  const value = { 'Content-Type': 'application/json' };
  if (String(apiToken ?? '').trim()) value.Authorization = `Bearer ${String(apiToken).trim()}`;
  return value;
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

async function readCompletionResponse(response, { onEvent }) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.body || contentType.includes('application/json')) {
    const payload = await response.json();
    return completionFromPayload(payload, onEvent);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const result = emptyCompletion();
  onEvent({ type: 'stream-open' });
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const split = buffer.split(/\r?\n/);
    buffer = split.pop() ?? '';
    for (const line of split) consumeSseLine(line, result, onEvent);
  }
  buffer += decoder.decode();
  for (const line of buffer.split(/\r?\n/)) consumeSseLine(line, result, onEvent);
  onEvent({ type: 'complete', ...result });
  return result;
}

function consumeSseLine(line, result, onEvent) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return;
  if (!trimmed.startsWith('data:')) return;
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return;
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    onEvent({ type: 'malformed-chunk', data: data.slice(0, 200) });
    return;
  }
  applyPayload(payload, result, onEvent);
}

function completionFromPayload(payload, onEvent) {
  const result = emptyCompletion();
  applyPayload(payload, result, onEvent);
  onEvent({ type: 'complete', ...result });
  return result;
}

function applyPayload(payload, result, onEvent) {
  const choice = payload.choices?.[0] ?? {};
  const source = choice.delta ?? choice.message ?? {};
  const contentDelta = textValue(source.content);
  const reasoningDelta = textValue(source.reasoning_content ?? source.reasoning);
  if (contentDelta) result.content += contentDelta;
  if (reasoningDelta) result.reasoning += reasoningDelta;
  result.finishReason = choice.finish_reason ?? result.finishReason;
  result.usage = payload.usage ?? result.usage;
  result.chunks += 1;
  onEvent({
    type: 'chunk',
    contentDelta,
    reasoningDelta,
    content: result.content,
    reasoning: result.reasoning,
    finishReason: result.finishReason,
    chunks: result.chunks,
  });
}

function emptyCompletion() {
  return { content: '', reasoning: '', finishReason: null, usage: null, chunks: 0 };
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((item) => typeof item === 'string' ? item : item?.text ?? '').join('');
}

async function safeError(response) {
  try {
    const text = await response.text();
    return text.trim().slice(0, 1000);
  } catch {
    return `HTTP ${response.status}`;
  }
}
