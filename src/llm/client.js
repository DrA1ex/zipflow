import { classifyServerError, LocalLlmError, normalizeServerError } from './errors.js';
import { appendChunk, completeResult, emptyCompletion } from './completion-state.js';
import { ByteChunkCollector } from '../utils/byte-buffer.js';
import { createCodexAppServerCompletion, listCodexAppServerModels } from './codex-app-server.js';
import {
  deadlineError, normalizeLlmStreamLimits, responseLimitError, SseEventParser,
} from './stream-limits.js';

const PROVIDERS = {
  ollama: {
    label: 'Ollama',
    nativeBaseUrl: 'http://127.0.0.1:11434/api',
  },
  lmstudio: {
    label: 'LM Studio',
    nativeBaseUrl: 'http://127.0.0.1:1234/api/v1',
  },
  openai: {
    label: 'OpenAI-compatible',
    openAiBaseUrl: 'http://127.0.0.1:8080/v1',
  },
  codex: {
    label: 'Codex app-server',
    rpcTransport: 'stdio, WebSocket, or Unix socket',
  },
};

const responseContexts = new WeakMap();

export function providerDefinition(provider) {
  return PROVIDERS[provider] ?? null;
}

export async function listLocalModelChoices(provider, {
  fetchImpl = fetch,
  timeoutMs = 10_000,
  apiToken = '',
  baseUrl = '',
  signal = null,
  settings = null,
  spawnImpl = undefined,
  executable = '',
  codexEndpoint = '',
  connectImpl = undefined,
  sleepImpl = undefined,
} = {}) {
  const definition = requireProvider(provider);
  if (provider === 'codex') return listCodexAppServerModels({
    settings, signal, timeoutMs, spawnImpl, executable, endpoint: codexEndpoint, apiToken,
    ...(connectImpl ? { connectImpl } : {}), ...(sleepImpl ? { sleepImpl } : {}),
  });
  const url = provider === 'lmstudio'
    ? `${definition.nativeBaseUrl}/models`
    : provider === 'ollama'
      ? `${definition.nativeBaseUrl}/tags`
      : `${resolveOpenAiBaseUrl(definition, baseUrl)}/models`;
  const response = await request(fetchImpl, url, {
    method: 'GET', headers: headers(apiToken, false),
  }, { provider, signal, limits: normalizeLlmStreamLimits({}, { timeoutMs }) });
  const payload = await readJsonResponse(response, provider);
  if (provider === 'lmstudio' && Array.isArray(payload.models)) return lmStudioChoices(payload.models);
  if (provider === 'ollama' && Array.isArray(payload.models)) return ollamaChoices(payload.models);
  return openAiModelChoices(payload.data ?? []);
}

export async function loadLmStudioModel(model, config = {}, {
  fetchImpl = fetch,
  timeoutMs = 600_000,
  apiToken = '',
  signal = null,
} = {}) {
  const definition = requireProvider('lmstudio');
  const body = compactObject({
    model,
    context_length: positiveInteger(config.contextLength),
    eval_batch_size: positiveInteger(config.evalBatchSize),
    flash_attention: booleanOrUndefined(config.flashAttention),
    offload_kv_cache_to_gpu: booleanOrUndefined(config.offloadKvCacheToGpu),
    num_experts: positiveInteger(config.numExperts),
    echo_load_config: true,
  });
  const response = await request(fetchImpl, `${definition.nativeBaseUrl}/models/load`, {
    method: 'POST', headers: headers(apiToken), body: JSON.stringify(body),
  }, {
    allowHttpFailure: true, provider: 'lmstudio', signal,
    limits: normalizeLlmStreamLimits({}, { timeoutMs }),
  });
  if (!response.ok) throw await responseError(response, 'lmstudio');
  const payload = await readJsonResponse(response, 'lmstudio');
  if (!payload.instance_id) throw new Error('LM Studio loaded the model but did not return an instance ID.');
  return {
    instanceId: payload.instance_id,
    loadTimeSeconds: Number(payload.load_time_seconds ?? 0),
    config: payload.load_config ?? {},
  };
}

export async function unloadLmStudioModel(instanceId, {
  fetchImpl = fetch,
  timeoutMs = 120_000,
  apiToken = '',
  signal = null,
} = {}) {
  if (!String(instanceId ?? '').trim()) return false;
  const definition = requireProvider('lmstudio');
  const response = await request(fetchImpl, `${definition.nativeBaseUrl}/models/unload`, {
    method: 'POST', headers: headers(apiToken), body: JSON.stringify({ instance_id: instanceId }),
  }, {
    allowHttpFailure: true, provider: 'lmstudio', signal,
    limits: normalizeLlmStreamLimits({}, { timeoutMs }),
  });
  if (!response.ok) throw await responseError(response, 'lmstudio');
  await discardResponse(response);
  return true;
}

export async function listLocalModels(provider, options = {}) {
  return (await listLocalModelChoices(provider, options)).map((item) => item.id);
}

export async function createLocalCompletion({
  provider,
  model,
  messages,
  responseSchema,
  maxTokens = 1_024,
  apiToken = '',
  baseUrl = '',
  apiMode = 'auto',
  reasoningEffort = 'auto',
  contextLength = null,
  reasoningOffSupported = false,
  loadedModel = false,
}, {
  fetchImpl = fetch,
  timeoutMs = 600_000,
  connectionTimeoutMs = null,
  totalDeadlineMs = null,
  idleTimeoutMs = null,
  streamLimits = null,
  onEvent = () => {},
  signal = null,
  settings = null,
  spawnImpl = undefined,
  executable = '',
  codexEndpoint = '',
  connectImpl = undefined,
  sleepImpl = undefined,
} = {}) {
  const limits = normalizeLlmStreamLimits({
    ...(streamLimits ?? {}),
    connectionTimeoutMs: connectionTimeoutMs ?? streamLimits?.connectionTimeoutMs,
    totalDeadlineMs: totalDeadlineMs ?? streamLimits?.totalDeadlineMs,
    idleTimeoutMs: idleTimeoutMs ?? streamLimits?.idleTimeoutMs,
  }, { timeoutMs });
  const requestOptions = { fetchImpl, limits, onEvent, signal };
  if (provider === 'codex') {
    return createCodexAppServerCompletion({ model, messages, responseSchema, reasoningEffort, maxTokens }, {
      settings, signal, timeoutMs: limits.totalDeadlineMs, idleTimeoutMs: limits.idleTimeoutMs,
      rpcTimeoutMs: limits.connectionTimeoutMs,
      maxAnswerBytes: limits.maxAnswerBytes, maxReasoningBytes: limits.maxReasoningBytes,
      onEvent, spawnImpl, executable, endpoint: codexEndpoint, apiToken,
      ...(connectImpl ? { connectImpl } : {}), ...(sleepImpl ? { sleepImpl } : {}),
    });
  }
  if (provider === 'lmstudio') {
    return createLmStudioCompletion({
      model, messages, maxTokens, apiToken, contextLength, reasoningOffSupported, loadedModel,
    }, requestOptions);
  }
  if (provider === 'ollama') {
    return createOllamaCompletion({ model, messages, responseSchema, maxTokens, apiToken }, requestOptions);
  }
  return createOpenAiCompatibleCompletion({
    provider, model, messages, responseSchema, maxTokens, apiToken, baseUrl, apiMode, reasoningEffort,
  }, requestOptions);
}

async function createLmStudioCompletion({
  model, messages, maxTokens, apiToken, contextLength, reasoningOffSupported, loadedModel,
}, { fetchImpl, limits, onEvent, signal }) {
  const definition = requireProvider('lmstudio');
  const { systemPrompt, input } = nativeMessages(messages);
  const body = {
    model,
    input,
    system_prompt: systemPrompt || undefined,
    stream: true,
    temperature: 0,
    max_output_tokens: maxTokens,
    store: false,
  };
  if (contextLength && !loadedModel) body.context_length = contextLength;
  if (reasoningOffSupported) body.reasoning = 'off';
  onEvent({
    type: 'request', attempt: 1, format: 'native', transport: 'LM Studio native',
    endpoint: '/api/v1/chat', model, loadedModel, contextLength: body.context_length ?? null,
  });
  const response = await request(fetchImpl, `${definition.nativeBaseUrl}/chat`, {
    method: 'POST', headers: headers(apiToken), body: JSON.stringify(body),
  }, { allowHttpFailure: true, provider: 'lmstudio', signal, limits });
  if (!response.ok) throw await responseError(response, 'lmstudio');
  return readLmStudioResponse(response, { onEvent, signal, limits });
}

async function createOllamaCompletion({
  model, messages, responseSchema, maxTokens, apiToken,
}, { fetchImpl, limits, onEvent, signal }) {
  const definition = requireProvider('ollama');
  const common = {
    model,
    messages,
    stream: true,
    options: { temperature: 0, num_predict: maxTokens },
  };
  const attempts = responseSchema
    ? [{ ...common, format: responseSchema }, { ...common, format: 'json' }]
    : [common];
  let firstError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    onEvent({
      type: 'request', attempt: index + 1,
      format: responseSchema ? (index === 0 ? 'json_schema' : 'json') : 'text',
      transport: 'Ollama native', endpoint: '/api/chat', model,
    });
    const response = await request(fetchImpl, `${definition.nativeBaseUrl}/chat`, {
      method: 'POST', headers: headers(apiToken), body: JSON.stringify(attempts[index]),
    }, { allowHttpFailure: true, provider: 'ollama', signal, limits });
    if (!response.ok) {
      const error = await responseError(response, 'ollama');
      firstError ??= error;
      if (index === attempts.length - 1 || error.retryableWithSmallerPrompt) throw error;
      onEvent({ type: 'retry', reason: error.message });
      continue;
    }
    return readOllamaResponse(response, { onEvent, signal, limits });
  }
  throw firstError ?? classifyServerError('Unknown Ollama error.', { provider: 'ollama' });
}

async function createOpenAiCompatibleCompletion({
  provider, model, messages, responseSchema, maxTokens, apiToken, baseUrl, apiMode, reasoningEffort,
}, requestOptions) {
  const modes = apiMode === 'responses' || apiMode === 'chat-completions'
    ? [apiMode]
    : ['responses', 'chat-completions'];
  let firstError = null;
  for (let index = 0; index < modes.length; index += 1) {
    const mode = modes[index];
    try {
      if (mode === 'responses') {
        return await createOpenAiResponsesCompletion({
          provider, model, messages, responseSchema, maxTokens, apiToken, baseUrl, reasoningEffort,
        }, requestOptions);
      }
      return await createOpenAiChatCompletion({
        provider, model, messages, responseSchema, maxTokens, apiToken, baseUrl, reasoningEffort,
      }, requestOptions);
    } catch (error) {
      firstError ??= error;
      if (index === modes.length - 1 || !isMissingEndpointError(error)) throw error;
      requestOptions.onEvent({
        type: 'retry', reason: `${mode} endpoint is unavailable; trying ${modes[index + 1]}.`,
      });
    }
  }
  throw firstError ?? classifyServerError('Unknown OpenAI-compatible LLM error.', { provider });
}

async function createOpenAiChatCompletion({
  provider, model, messages, responseSchema, maxTokens, apiToken, baseUrl, reasoningEffort,
}, { fetchImpl, limits, onEvent, signal }) {
  const definition = requireProvider(provider);
  const root = resolveOpenAiBaseUrl(definition, baseUrl);
  const common = compactObject({
    model, messages, stream: true, temperature: 0, max_tokens: maxTokens,
    reasoning_effort: normalizedReasoningEffort(reasoningEffort),
  });
  const attempts = responseSchema ? [
    {
      ...common,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'zipflow_change_summary', strict: true, schema: responseSchema },
      },
    },
    { ...common, response_format: { type: 'json_object' } },
  ] : [common];
  let firstError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    onEvent({
      type: 'request', attempt: index + 1,
      format: responseSchema ? (index === 0 ? 'json_schema' : 'json_object') : 'text',
      transport: `${providerDefinition(provider).label} Chat Completions`, endpoint: '/chat/completions', model,
      reasoningEffort: normalizedReasoningEffort(reasoningEffort) ?? null,
    });
    const response = await request(fetchImpl, `${root}/chat/completions`, {
      method: 'POST', headers: headers(apiToken), body: JSON.stringify(attempts[index]),
    }, { allowHttpFailure: true, provider, signal, limits });
    if (!response.ok) {
      const error = await responseError(response, provider);
      firstError ??= error;
      if (index === attempts.length - 1 || error.retryableWithSmallerPrompt) throw error;
      onEvent({ type: 'retry', reason: error.message });
      continue;
    }
    return readOpenAiResponse(response, { onEvent, provider, signal, limits });
  }
  throw firstError ?? classifyServerError('Unknown OpenAI-compatible chat error.', { provider });
}

async function createOpenAiResponsesCompletion({
  provider, model, messages, responseSchema, maxTokens, apiToken, baseUrl, reasoningEffort,
}, { fetchImpl, limits, onEvent, signal }) {
  const definition = requireProvider(provider);
  const root = resolveOpenAiBaseUrl(definition, baseUrl);
  const common = compactObject({
    model,
    input: messages,
    stream: true,
    store: false,
    max_output_tokens: maxTokens,
    reasoning: normalizedReasoningEffort(reasoningEffort)
      ? { effort: normalizedReasoningEffort(reasoningEffort) }
      : undefined,
  });
  const attempts = responseSchema ? [
    {
      ...common,
      text: {
        format: { type: 'json_schema', name: 'zipflow_change_summary', strict: true, schema: responseSchema },
      },
    },
    { ...common, text: { format: { type: 'json_object' } } },
  ] : [common];
  let firstError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    onEvent({
      type: 'request', attempt: index + 1,
      format: responseSchema ? (index === 0 ? 'json_schema' : 'json_object') : 'text',
      transport: `${providerDefinition(provider).label} Responses API`, endpoint: '/responses', model,
      reasoningEffort: normalizedReasoningEffort(reasoningEffort) ?? null,
    });
    const response = await request(fetchImpl, `${root}/responses`, {
      method: 'POST', headers: headers(apiToken), body: JSON.stringify(attempts[index]),
    }, { allowHttpFailure: true, provider, signal, limits });
    if (!response.ok) {
      const error = await responseError(response, provider);
      firstError ??= error;
      if (index === attempts.length - 1 || error.retryableWithSmallerPrompt) throw error;
      onEvent({ type: 'retry', reason: error.message });
      continue;
    }
    return readOpenAiResponsesResponse(response, { onEvent, provider, signal, limits });
  }
  throw firstError ?? classifyServerError('Unknown OpenAI-compatible Responses API error.', { provider });
}

function resolveOpenAiBaseUrl(definition, baseUrl) {
  const value = String(baseUrl ?? '').trim() || definition.openAiBaseUrl;
  return value.replace(/\/+$/, '');
}

function normalizedReasoningEffort(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized && normalized !== 'auto' ? normalized : undefined;
}

function isMissingEndpointError(error) {
  return [404, 405, 501].includes(Number(error?.status))
    || ['not_found', 'endpoint_not_found', 'unsupported_endpoint'].includes(error?.code);
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

async function request(fetchImpl, url, options, {
  allowHttpFailure = false, provider = null, signal = null, limits,
} = {}) {
  const controller = new AbortController();
  const activeLimits = limits ?? normalizeLlmStreamLimits();
  const abort = () => controller.abort('cancelled');
  const connectionTimer = setTimeout(() => controller.abort('connection'), activeLimits.connectionTimeoutMs);
  const totalTimer = setTimeout(() => controller.abort('total'), activeLimits.totalDeadlineMs);
  signal?.addEventListener('abort', abort, { once: true });
  const cleanup = () => {
    clearTimeout(connectionTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', abort);
  };
  try {
    if (signal?.aborted) throw cancelledError(provider);
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    clearTimeout(connectionTimer);
    responseContexts.set(response, { controller, cleanup, limits: activeLimits, provider, signal });
    if (!allowHttpFailure && !response.ok) throw await responseError(response, provider);
    return response;
  } catch (error) {
    cleanup();
    throw normalizeAbortError(error, { controller, provider, signal, limits: activeLimits });
  }
}

async function readOpenAiResponse(response, { onEvent, provider, signal, limits }) {
  const context = responseContexts.get(response);
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body || contentType.includes('application/json')) {
      const payload = await readCompletionJsonResponse(response, provider, limits);
      if (payload.error) throw classifyPayloadError(payload, provider);
      return completionFromOpenAiPayload(payload, onEvent, limits, provider);
    }
    const result = emptyCompletion(limits, provider);
    onEvent({ type: 'stream-open' });
    const raw = await consumeSse(response, ({ data }) => {
      if (data === '[DONE]') {
        result.terminalObserved = true;
        return;
      }
      if (!data) return;
      const payload = parseJsonChunk(data, onEvent);
      if (!payload) return;
      if (payload.error) throw classifyPayloadError(payload, provider);
      applyOpenAiPayload(payload, result, onEvent);
    }, { signal, provider, limits, context });
    result.rawResponse = raw.value;
    result.rawResponseTruncated = raw.truncated;
    return completeResult(result, onEvent);
  } catch (error) {
    throw normalizeAbortError(error, context ?? { provider, signal, limits });
  } finally {
    cleanupResponse(response);
  }
}

async function readOllamaResponse(response, { onEvent, signal, limits }) {
  const provider = 'ollama';
  const context = responseContexts.get(response);
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body || contentType.includes('application/json')) {
      const payload = await readCompletionJsonResponse(response, provider, limits);
      if (payload.error) throw classifyPayloadError(payload, provider);
      return completionFromOllamaPayload(payload, onEvent, limits);
    }
    const result = emptyCompletion(limits, provider);
    onEvent({ type: 'stream-open' });
    const raw = await consumeNdjson(response, (payload) => applyOllamaPayload(payload, result, onEvent), {
      signal, provider, limits, context,
    });
    result.rawResponse = raw.value;
    result.rawResponseTruncated = raw.truncated;
    return completeResult(result, onEvent);
  } catch (error) {
    throw normalizeAbortError(error, context ?? { provider, signal, limits });
  } finally {
    cleanupResponse(response);
  }
}

async function readOpenAiResponsesResponse(response, { onEvent, provider, signal, limits }) {
  const context = responseContexts.get(response);
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body || contentType.includes('application/json')) {
      const payload = await readCompletionJsonResponse(response, provider, limits);
      if (payload.error) throw classifyPayloadError(payload, provider);
      return completionFromResponsesPayload(payload, onEvent, limits, provider);
    }
    const result = emptyCompletion(limits, provider);
    onEvent({ type: 'stream-open' });
    const raw = await consumeSse(response, ({ event, data }) => {
      if (data === '[DONE]') return;
      if (!data) return;
      const payload = parseJsonChunk(data, onEvent);
      if (!payload) return;
      applyResponsesPayload(event || payload.type, payload, result, onEvent, provider);
    }, { signal, provider, limits, context });
    result.rawResponse = raw.value;
    result.rawResponseTruncated = raw.truncated;
    return completeResult(result, onEvent);
  } catch (error) {
    throw normalizeAbortError(error, context ?? { provider, signal, limits });
  } finally {
    cleanupResponse(response);
  }
}

async function readLmStudioResponse(response, { onEvent, signal, limits }) {
  const provider = 'lmstudio';
  const context = responseContexts.get(response);
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body || contentType.includes('application/json')) {
      const payload = await readCompletionJsonResponse(response, provider, limits);
      if (payload.error) throw classifyPayloadError(payload, provider);
      if (payload.choices) return completionFromOpenAiPayload(payload, onEvent, limits, provider);
      return completionFromLmResult(payload, onEvent, limits, provider);
    }
    const result = emptyCompletion(limits, provider);
    onEvent({ type: 'stream-open' });
    const raw = await consumeSse(response, ({ event, data }) => {
      if (data === '[DONE]') return;
      if (!data) return;
      const payload = parseJsonChunk(data, onEvent);
      if (!payload) return;
      applyLmStudioEvent(event || payload.type, payload, result, onEvent);
    }, { signal, provider, limits, context });
    result.rawResponse = raw.value;
    result.rawResponseTruncated = raw.truncated;
    return completeResult(result, onEvent);
  } catch (error) {
    throw normalizeAbortError(error, context ?? { provider, signal, limits });
  } finally {
    cleanupResponse(response);
  }
}

async function consumeNdjson(response, consume, { signal, provider, limits, context }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const raw = new ByteChunkCollector(limits.maxRawResponseBytes, { label: 'NDJSON response' });
  let buffer = '';
  let completed = false;
  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const payload = parseJsonChunk(trimmed, () => {});
    if (payload) consume(payload);
  };
  try {
    while (true) {
      if (signal?.aborted) throw cancelledError(provider);
      if (context?.controller?.signal.aborted) throw normalizeAbortError(abortException(), context);
      const { value, done } = await readStreamChunk(reader, limits.idleTimeoutMs, context?.controller, provider);
      if (done) break;
      try {
        raw.append(value);
      } catch (error) {
        if (error.code !== 'byte_limit_exceeded') throw error;
        throw responseLimitError('NDJSON response', limits.maxRawResponseBytes, error.actualBytes, provider);
      }
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer) > limits.maxUnparsedBufferBytes) {
        throw responseLimitError('NDJSON buffer', limits.maxUnparsedBufferBytes, Buffer.byteLength(buffer), provider);
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    consumeLine(buffer);
    completed = true;
    return { value: raw.toString(), truncated: false };
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
  }
}

async function consumeSse(response, consume, { signal, provider, limits, context }) {
  const reader = response.body.getReader();
  const parser = new SseEventParser({
    maxEventBytes: limits.maxSseEventBytes,
    maxBufferBytes: limits.maxUnparsedBufferBytes,
    maxRawBytes: limits.maxRawResponseBytes,
    provider,
    onEvent: consume,
  });
  let completed = false;
  try {
    while (true) {
      if (signal?.aborted) throw cancelledError(provider);
      if (context?.controller?.signal.aborted) throw normalizeAbortError(abortException(), context);
      const { value, done } = await readStreamChunk(reader, limits.idleTimeoutMs, context?.controller, provider);
      if (done) break;
      parser.push(value);
    }
    parser.finish();
    completed = true;
    return { value: parser.rawResponse(), truncated: parser.rawResponseTruncated() };
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
  }
}

async function readStreamChunk(reader, idleTimeoutMs, controller, provider) {
  let timer = null;
  let removeAbort = () => {};
  try {
    const aborted = new Promise((resolve, reject) => {
      if (!controller) return;
      const abort = () => reject(abortException());
      if (controller.signal.aborted) abort();
      else {
        controller.signal.addEventListener('abort', abort, { once: true });
        removeAbort = () => controller.signal.removeEventListener('abort', abort);
      }
    });
    return await Promise.race([
      reader.read(),
      aborted,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller?.abort('idle');
          reject(deadlineError('idle', idleTimeoutMs, provider));
        }, idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort();
  }
}

function applyLmStudioEvent(event, payload, result, onEvent) {
  if (event === 'error' || payload.type === 'error' || payload.error) throw classifyPayloadError(payload, 'lmstudio');
  if (event === 'chat.start') onEvent({ type: 'chat-start', modelInstanceId: payload.model_instance_id });
  else if (event === 'model_load.start') onEvent({ type: 'model-load-start', modelInstanceId: payload.model_instance_id });
  else if (event === 'model_load.progress') onEvent({ type: 'model-load-progress', progress: payload.progress });
  else if (event === 'model_load.end') onEvent({ type: 'model-load-end', seconds: payload.load_time_seconds });
  else if (event === 'prompt_processing.start') onEvent({ type: 'prompt-progress', progress: 0 });
  else if (event === 'prompt_processing.progress') onEvent({ type: 'prompt-progress', progress: payload.progress });
  else if (event === 'prompt_processing.end') onEvent({ type: 'prompt-progress', progress: 1 });
  else if (event === 'reasoning.delta') appendChunk(result, '', textValue(payload.content), onEvent);
  else if (event === 'message.delta') appendChunk(result, textValue(payload.content), '', onEvent);
  else if (event === 'chat.end') {
    result.terminalObserved = true;
    result.terminalStatus = 'completed';
    applyLmResult(payload.result, result, onEvent);
  }
}

function completionFromOllamaPayload(payload, onEvent, limits) {
  const result = emptyCompletion(limits, 'ollama');
  applyOllamaPayload(payload, result, onEvent);
  return completeResult(result, onEvent);
}

function applyOllamaPayload(payload, result, onEvent) {
  if (payload?.error) throw classifyPayloadError(payload, 'ollama');
  appendChunk(
    result,
    result.contentBytes === 0 || !payload.done ? textValue(payload?.message?.content ?? payload?.response) : '',
    result.reasoningBytes === 0 || !payload.done ? textValue(payload?.message?.thinking ?? payload?.thinking) : '',
    onEvent,
  );
  if (payload?.done) {
    result.terminalObserved = true;
    result.terminalStatus = 'completed';
    result.finishReason = payload.done_reason ?? 'stop';
    result.usage = {
      prompt_tokens: payload.prompt_eval_count ?? null,
      completion_tokens: payload.eval_count ?? null,
      total_duration: payload.total_duration ?? null,
      load_duration: payload.load_duration ?? null,
      prompt_eval_duration: payload.prompt_eval_duration ?? null,
      eval_duration: payload.eval_duration ?? null,
    };
  }
}

function completionFromResponsesPayload(payload, onEvent, limits, provider) {
  const result = emptyCompletion(limits, provider);
  applyResponsesPayload(payload.type, payload, result, onEvent, provider);
  if (!result.terminalObserved && Array.isArray(payload?.output)) {
    result.terminalObserved = true;
    result.terminalStatus = payload?.status ?? 'completed';
  }
  return completeResult(result, onEvent);
}

function applyResponsesPayload(event, payload, result, onEvent, provider) {
  if (event === 'error' || payload?.error || event === 'response.failed') {
    throw classifyPayloadError(payload?.response?.error ?? payload, provider);
  }
  if (event === 'response.output_text.delta') appendChunk(result, textValue(payload.delta), '', onEvent);
  else if (event === 'response.reasoning_summary_text.delta' || event === 'response.reasoning_text.delta') {
    appendChunk(result, '', textValue(payload.delta), onEvent);
  } else if (event === 'response.completed' || event === 'response.incomplete' || payload?.output) {
    const response = payload.response ?? payload;
    applyResponsesResult(response, result, onEvent);
    if (event === 'response.completed' || response?.status === 'completed') {
      result.terminalObserved = true;
      result.terminalStatus = 'completed';
    } else if (event === 'response.incomplete' || response?.status === 'incomplete') {
      result.terminalObserved = true;
      result.terminalStatus = 'incomplete';
      result.incompleteReason = response?.incomplete_details?.reason ?? response?.incompleteDetails?.reason ?? 'response incomplete';
    }
  }
}

function applyResponsesResult(payload, result, onEvent) {
  let content = '';
  let reasoning = '';
  for (const item of payload?.output ?? []) {
    if (item.type === 'message') content += textValue(item.content);
    if (item.type === 'reasoning') reasoning += textValue(item.summary ?? item.content);
  }
  if (result.contentBytes === 0) appendChunk(result, content || textValue(payload?.output_text), '', onEvent);
  if (result.reasoningBytes === 0) appendChunk(result, '', reasoning, onEvent);
  result.usage = payload?.usage ?? result.usage;
  result.finishReason = payload?.status ?? result.finishReason ?? 'stop';
}

function completionFromOpenAiPayload(payload, onEvent, limits, provider) {
  const result = emptyCompletion(limits, provider);
  applyOpenAiPayload(payload, result, onEvent);
  if (!result.terminalObserved && Array.isArray(payload?.choices)) {
    result.terminalObserved = true;
    result.terminalStatus = 'completed';
  }
  return completeResult(result, onEvent);
}

function applyOpenAiPayload(payload, result, onEvent) {
  const choice = payload.choices?.[0] ?? {};
  const source = choice.delta ?? choice.message ?? {};
  appendChunk(result, textValue(source.content), textValue(source.reasoning_content ?? source.reasoning), onEvent);
  result.finishReason = choice.finish_reason ?? result.finishReason;
  if (choice.finish_reason) {
    result.terminalObserved = true;
    result.terminalStatus = choice.finish_reason;
  }
  result.usage = payload.usage ?? result.usage;
}

function completionFromLmResult(payload, onEvent, limits, provider) {
  const result = emptyCompletion(limits, provider);
  result.terminalObserved = true;
  result.terminalStatus = 'completed';
  applyLmResult(payload, result, onEvent);
  return completeResult(result, onEvent);
}

function applyLmResult(payload, result, onEvent) {
  for (const item of payload?.output ?? []) {
    if (item.type === 'message' && result.contentBytes === 0) appendChunk(result, textValue(item.content), '', onEvent);
    if (item.type === 'reasoning' && result.reasoningBytes === 0) appendChunk(result, '', textValue(item.content), onEvent);
  }
  result.usage = payload?.stats ?? result.usage;
  result.finishReason ??= 'stop';
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((item) => typeof item === 'string' ? item : item?.text ?? item?.content ?? '').join('');
}

function nativeMessages(messages) {
  const systemPrompt = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n\n');
  const nonSystem = messages.filter((item) => item.role !== 'system');
  const input = nonSystem.length <= 1
    ? String(nonSystem[0]?.content ?? '')
    : nonSystem.map((item) => `${nativeRoleLabel(item.role)}:\n${String(item.content ?? '')}`).join('\n\n');
  return { systemPrompt, input };
}

function nativeRoleLabel(role) {
  if (role === 'assistant') return 'PREVIOUS MODEL CONTEXT';
  if (role === 'user') return 'CURRENT USER REQUEST';
  return String(role ?? 'context').toUpperCase();
}

function ollamaChoices(models) {
  return models
    .map((item) => {
      const id = item.model || item.name;
      if (!id) return null;
      return {
        id, key: id, label: id,
        paramsString: item.details?.parameter_size ?? null,
        quantization: item.details?.quantization_level ?? null,
        sizeBytes: Number(item.size ?? 0) || null,
        format: item.details?.format ?? null,
        loaded: null,
        contextLength: null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.label.localeCompare(right.label));
}

function openAiModelChoices(models) {
  return [...new Set(models.map((item) => item?.id).filter(Boolean))]
    .sort()
    .map((id) => ({ id, key: id, label: id, loaded: null, contextLength: null }));
}

function lmStudioChoices(models) {
  const choices = [];
  for (const item of models.filter((model) => model.type !== 'embedding')) {
    const loadedInstance = preferredLoadedInstance(item.loaded_instances ?? []);
    choices.push({
      id: item.key,
      key: item.key,
      label: item.display_name || item.key,
      displayName: item.display_name || item.key,
      paramsString: item.params_string ?? null,
      quantization: item.quantization?.name ?? null,
      sizeBytes: Number(item.size_bytes ?? 0) || null,
      maxContextLength: Number(item.max_context_length ?? 0) || null,
      format: item.format ?? null,
      reasoningOptions: item.capabilities?.reasoning?.allowed_options ?? [],
      loaded: Boolean(loadedInstance),
      loadedInstanceId: loadedInstance?.id ?? null,
      loadedInstanceIds: (item.loaded_instances ?? []).map((instance) => instance.id).filter(Boolean),
      contextLength: loadedInstance?.config?.context_length ?? null,
      config: loadedInstance?.config ?? {},
    });
  }
  return choices.sort((left, right) => Number(right.loaded) - Number(left.loaded) || left.label.localeCompare(right.label));
}

function preferredLoadedInstance(instances) {
  return [...instances].sort((left, right) => {
    const contextDelta = Number(right.config?.context_length ?? 0) - Number(left.config?.context_length ?? 0);
    return contextDelta || String(left.id ?? '').localeCompare(String(right.id ?? ''));
  })[0] ?? null;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function booleanOrUndefined(value) {
  return typeof value === 'boolean' ? value : undefined;
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
  const context = responseContexts.get(response);
  let text = '';
  try {
    text = await readBoundedResponseText(response, {
      context, provider, kind: 'error response',
      maxBytes: context?.limits?.maxRawResponseBytes ?? normalizeLlmStreamLimits().maxRawResponseBytes,
    });
  } catch (error) {
    if (error instanceof LocalLlmError) throw error;
    if (error?.name === 'AbortError' || context?.controller?.signal.aborted) {
      throw normalizeAbortError(error, context ?? { provider });
    }
    text = `HTTP ${response.status}`;
  } finally {
    cleanupResponse(response);
  }
  return classifyServerError(normalizeServerError(text, `HTTP ${response.status}`), {
    status: response.status, provider, responseBody: text.slice(0, 4_000),
  });
}

async function readJsonResponse(response, provider) {
  const context = responseContexts.get(response);
  try {
    const text = await readBoundedResponseText(response, {
      context, provider, kind: 'JSON response',
      maxBytes: context?.limits?.maxRawResponseBytes ?? normalizeLlmStreamLimits().maxRawResponseBytes,
    });
    return JSON.parse(text);
  } catch (error) {
    throw normalizeAbortError(error, context ?? { provider });
  } finally {
    cleanupResponse(response);
  }
}

async function readCompletionJsonResponse(response, provider, limits) {
  const context = responseContexts.get(response);
  const maxBytes = Math.min(Number.MAX_SAFE_INTEGER,
    limits.maxAnswerBytes + limits.maxReasoningBytes + limits.maxSseEventBytes);
  const text = await readBoundedResponseText(response, {
    context, provider, kind: 'completion response', maxBytes,
  });
  return JSON.parse(text);
}

async function discardResponse(response) {
  const context = responseContexts.get(response);
  try {
    await readBoundedResponseText(response, {
      context, provider: context?.provider, kind: 'response',
      maxBytes: context?.limits?.maxRawResponseBytes ?? normalizeLlmStreamLimits().maxRawResponseBytes,
    });
  } catch (error) {
    throw normalizeAbortError(error, context ?? {});
  } finally {
    cleanupResponse(response);
  }
}

async function readBoundedResponseText(response, { context, provider, kind, maxBytes }) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const collector = new ByteChunkCollector(maxBytes, { label: kind });
  let completed = false;
  try {
    while (true) {
      if (context?.controller?.signal.aborted) throw normalizeAbortError(abortException(), context);
      const { value, done } = await readStreamChunk(
        reader,
        context?.limits?.idleTimeoutMs ?? normalizeLlmStreamLimits().idleTimeoutMs,
        context?.controller,
        provider,
      );
      if (done) break;
      try {
        collector.append(value);
      } catch (error) {
        if (error.code !== 'byte_limit_exceeded') throw error;
        throw responseLimitError(kind, maxBytes, error.actualBytes, provider);
      }
    }
    completed = true;
    return collector.toString();
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
  }
}

function cleanupResponse(response) {
  const context = responseContexts.get(response);
  if (!context) return;
  responseContexts.delete(response);
  context.cleanup();
}

function normalizeAbortError(error, context = {}) {
  const { controller, provider = null, signal = null, limits = normalizeLlmStreamLimits() } = context;
  if (!(error?.name === 'AbortError' || controller?.signal.aborted)) return error;
  const reason = controller?.signal.reason;
  if (signal?.aborted || reason === 'cancelled') return cancelledError(provider);
  if (reason === 'connection') return deadlineError('connection', limits.connectionTimeoutMs, provider);
  if (reason === 'idle') return deadlineError('idle', limits.idleTimeoutMs, provider);
  return deadlineError('total', limits.totalDeadlineMs, provider);
}

function abortException() {
  const error = new Error('The request was aborted.');
  error.name = 'AbortError';
  return error;
}

function cancelledError(provider) {
  return new LocalLlmError('Local LLM generation was cancelled.', { code: 'cancelled', provider });
}
