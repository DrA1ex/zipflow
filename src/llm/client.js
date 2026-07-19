import { classifyServerError, normalizeServerError } from './errors.js';

const PROVIDERS = {
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    openAiBaseUrl: 'http://127.0.0.1:11434/v1',
    nativeBaseUrl: 'http://127.0.0.1:11434/api',
  },
  lmstudio: {
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    openAiBaseUrl: 'http://127.0.0.1:1234/v1',
    nativeBaseUrl: 'http://127.0.0.1:1234/api/v1',
  },
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
  const url = provider === 'lmstudio'
    ? `${definition.nativeBaseUrl}/models`
    : `${definition.openAiBaseUrl}/models`;
  const response = await request(fetchImpl, url, {
    method: 'GET', headers: headers(apiToken, false),
  }, timeoutMs, { provider });
  const payload = await response.json();
  if (provider === 'lmstudio' && Array.isArray(payload.models)) {
    return [...new Set(payload.models
      .filter((item) => item.type !== 'embedding')
      .flatMap((item) => preferredLmStudioIds(item))
      .filter(Boolean))].sort();
  }
  return [...new Set((payload.data ?? []).map((item) => item.id).filter(Boolean))].sort();
}

export async function createLocalCompletion({
  provider,
  model,
  messages,
  responseSchema,
  maxTokens = 1_024,
  apiToken = '',
  contextLength = null,
  reasoningOffSupported = false,
}, {
  fetchImpl = fetch,
  timeoutMs = 600_000,
  onEvent = () => {},
} = {}) {
  if (provider === 'lmstudio') {
    return createLmStudioCompletion({
      model, messages, maxTokens, apiToken, contextLength, reasoningOffSupported,
    }, { fetchImpl, timeoutMs, onEvent });
  }
  return createOpenAiCompletion({
    provider, model, messages, responseSchema, maxTokens, apiToken,
  }, { fetchImpl, timeoutMs, onEvent });
}

async function createLmStudioCompletion({
  model, messages, maxTokens, apiToken, contextLength, reasoningOffSupported,
}, { fetchImpl, timeoutMs, onEvent }) {
  const definition = requireProvider('lmstudio');
  const body = {
    model,
    input: renderMessages(messages),
    stream: true,
    temperature: 0,
    max_output_tokens: maxTokens,
    store: false,
  };
  if (contextLength) body.context_length = contextLength;
  if (reasoningOffSupported) body.reasoning = 'off';
  onEvent({ type: 'request', attempt: 1, format: 'native-json', contextLength: body.context_length ?? null });
  const response = await request(fetchImpl, `${definition.nativeBaseUrl}/chat`, {
    method: 'POST', headers: headers(apiToken), body: JSON.stringify(body),
  }, timeoutMs, { allowHttpFailure: true, provider: 'lmstudio' });
  if (!response.ok) throw await responseError(response, 'lmstudio');
  return readLmStudioResponse(response, { onEvent });
}

async function createOpenAiCompletion({
  provider, model, messages, responseSchema, maxTokens, apiToken,
}, { fetchImpl, timeoutMs, onEvent }) {
  const definition = requireProvider(provider);
  const common = { model, messages, stream: true, temperature: 0, max_tokens: maxTokens };
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
  let firstError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    onEvent({ type: 'request', attempt: index + 1, format: index === 0 ? 'json_schema' : 'json_object' });
    const response = await request(fetchImpl, `${definition.openAiBaseUrl}/chat/completions`, {
      method: 'POST', headers: headers(apiToken), body: JSON.stringify(attempts[index]),
    }, timeoutMs, { allowHttpFailure: true, provider });
    if (!response.ok) {
      const error = await responseError(response, provider);
      firstError ??= error;
      if (index === attempts.length - 1 || error.retryableWithSmallerPrompt) throw error;
      onEvent({ type: 'retry', reason: error.message });
      continue;
    }
    return readOpenAiResponse(response, { onEvent, provider });
  }
  throw firstError ?? classifyServerError('Unknown local LLM error.', { provider });
}

function requireProvider(provider) {
  const definition = providerDefinition(provider);
  if (!definition) throw new Error('Local LLM provider is not configured.');
  return definition;
}

function headers(apiToken, json = true) {
  const value = json ? { 'Content-Type': 'application/json' } : {};
  if (String(apiToken ?? '').trim()) value.Authorization = `Bearer ${String(apiToken).trim()}`;
  return value;
}

async function request(fetchImpl, url, options, timeoutMs, { allowHttpFailure = false, provider = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!allowHttpFailure && !response.ok) throw await responseError(response, provider);
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw classifyServerError(`Local LLM request timed out after ${Math.round(timeoutMs / 1000)} seconds.`, { provider });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readOpenAiResponse(response, { onEvent, provider }) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.body || contentType.includes('application/json')) {
    const payload = await response.json();
    if (payload.error) throw classifyPayloadError(payload, provider);
    return completionFromOpenAiPayload(payload, onEvent);
  }
  const result = emptyCompletion();
  onEvent({ type: 'stream-open' });
  await consumeSse(response, ({ data }) => {
    if (!data || data === '[DONE]') return;
    const payload = parseJsonChunk(data, onEvent);
    if (!payload) return;
    if (payload.error) throw classifyPayloadError(payload, provider);
    applyOpenAiPayload(payload, result, onEvent);
  });
  onEvent({ type: 'complete', ...result });
  return result;
}

async function readLmStudioResponse(response, { onEvent }) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.body || contentType.includes('application/json')) {
    const payload = await response.json();
    if (payload.error) throw classifyPayloadError(payload, 'lmstudio');
    if (payload.choices) return completionFromOpenAiPayload(payload, onEvent);
    return completionFromLmResult(payload, onEvent);
  }
  const result = emptyCompletion();
  onEvent({ type: 'stream-open' });
  await consumeSse(response, ({ event, data }) => {
    if (!data || data === '[DONE]') return;
    const payload = parseJsonChunk(data, onEvent);
    if (!payload) return;
    applyLmStudioEvent(event || payload.type, payload, result, onEvent);
  });
  onEvent({ type: 'complete', ...result });
  return result;
}

async function consumeSse(response, consume) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      consume(parseSseBlock(block));
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(parseSseBlock(buffer));
}

function parseSseBlock(block) {
  let event = '';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n').trim() };
}

function applyLmStudioEvent(event, payload, result, onEvent) {
  if (event === 'error' || payload.type === 'error' || payload.error) {
    throw classifyPayloadError(payload, 'lmstudio');
  }
  if (event === 'model_load.start') onEvent({ type: 'model-load-start' });
  else if (event === 'model_load.progress') onEvent({ type: 'model-load-progress', progress: payload.progress });
  else if (event === 'model_load.end') onEvent({ type: 'model-load-end', seconds: payload.load_time_seconds });
  else if (event === 'prompt_processing.start') onEvent({ type: 'prompt-progress', progress: 0 });
  else if (event === 'prompt_processing.progress') onEvent({ type: 'prompt-progress', progress: payload.progress });
  else if (event === 'prompt_processing.end') onEvent({ type: 'prompt-progress', progress: 1 });
  else if (event === 'reasoning.delta') appendChunk(result, '', textValue(payload.content), onEvent);
  else if (event === 'message.delta') appendChunk(result, textValue(payload.content), '', onEvent);
  else if (event === 'chat.end') applyLmResult(payload.result, result, onEvent);
}

function completionFromOpenAiPayload(payload, onEvent) {
  const result = emptyCompletion();
  applyOpenAiPayload(payload, result, onEvent);
  onEvent({ type: 'complete', ...result });
  return result;
}

function applyOpenAiPayload(payload, result, onEvent) {
  const choice = payload.choices?.[0] ?? {};
  const source = choice.delta ?? choice.message ?? {};
  appendChunk(result, textValue(source.content), textValue(source.reasoning_content ?? source.reasoning), onEvent);
  result.finishReason = choice.finish_reason ?? result.finishReason;
  result.usage = payload.usage ?? result.usage;
}

function completionFromLmResult(payload, onEvent) {
  const result = emptyCompletion();
  applyLmResult(payload, result, onEvent);
  onEvent({ type: 'complete', ...result });
  return result;
}

function applyLmResult(payload, result, onEvent) {
  for (const item of payload?.output ?? []) {
    if (item.type === 'message' && !result.content) appendChunk(result, textValue(item.content), '', onEvent);
    if (item.type === 'reasoning' && !result.reasoning) appendChunk(result, '', textValue(item.content), onEvent);
  }
  result.usage = payload?.stats ?? result.usage;
  result.finishReason ??= 'stop';
}

function appendChunk(result, contentDelta, reasoningDelta, onEvent) {
  if (!contentDelta && !reasoningDelta) return;
  if (contentDelta) result.content += contentDelta;
  if (reasoningDelta) result.reasoning += reasoningDelta;
  result.chunks += 1;
  onEvent({
    type: 'chunk', contentDelta, reasoningDelta,
    content: result.content, reasoning: result.reasoning,
    finishReason: result.finishReason, chunks: result.chunks,
  });
}

function emptyCompletion() {
  return { content: '', reasoning: '', finishReason: null, usage: null, chunks: 0 };
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((item) => typeof item === 'string' ? item : item?.text ?? item?.content ?? '').join('');
}

function renderMessages(messages) {
  return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
}

function preferredLmStudioIds(item) {
  const loaded = (item.loaded_instances ?? []).map((entry) => entry.id).filter(Boolean);
  return loaded.length ? loaded : [item.key];
}

function parseJsonChunk(data, onEvent) {
  try {
    return JSON.parse(data);
  } catch {
    onEvent({ type: 'malformed-chunk', data: data.slice(0, 200) });
    return null;
  }
}

function classifyPayloadError(payload, provider) {
  const source = payload.error ?? payload;
  const message = normalizeServerError(source);
  return classifyServerError(message, { provider, responseBody: payload });
}

async function responseError(response, provider) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = `HTTP ${response.status}`;
  }
  return classifyServerError(normalizeServerError(text, `HTTP ${response.status}`), {
    status: response.status, provider, responseBody: text.slice(0, 4_000),
  });
}
