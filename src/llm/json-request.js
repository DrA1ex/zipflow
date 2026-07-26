import { ByteChunkCollector } from '../utils/byte-buffer.js';
import { LocalLlmError } from './errors.js';
import {
  deadlineError, normalizeLlmStreamLimits, responseLimitError,
} from './stream-limits.js';

export async function requestLlmJson(fetchImpl, url, options, {
  provider = null,
  signal = null,
  timeoutMs = null,
  connectionTimeoutMs = null,
  totalDeadlineMs = null,
  idleTimeoutMs = null,
  streamLimits = null,
} = {}) {
  const limits = normalizeLlmStreamLimits({
    ...(streamLimits ?? {}),
    connectionTimeoutMs: connectionTimeoutMs ?? streamLimits?.connectionTimeoutMs,
    totalDeadlineMs: totalDeadlineMs ?? streamLimits?.totalDeadlineMs,
    idleTimeoutMs: idleTimeoutMs ?? streamLimits?.idleTimeoutMs,
  }, { timeoutMs });
  const controller = new AbortController();
  const abort = () => controller.abort('cancelled');
  const connectionTimer = setTimeout(() => controller.abort('connection'), limits.connectionTimeoutMs);
  const totalTimer = setTimeout(() => controller.abort('total'), limits.totalDeadlineMs);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw cancelledError(provider);
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    clearTimeout(connectionTimer);
    const text = await readBoundedJsonBody(response, { controller, limits, provider, signal });
    let payload = null;
    try { payload = JSON.parse(text); } catch (error) {
      if (response.ok) throw error;
    }
    return { ok: response.ok, status: response.status, payload, text };
  } catch (error) {
    throw normalizeJsonRequestError(error, { controller, limits, provider, signal });
  } finally {
    clearTimeout(connectionTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', abort);
  }
}

async function readBoundedJsonBody(response, { controller, limits, provider, signal }) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const responseLabel = 'JSON response';
  const collector = new ByteChunkCollector(limits.maxRawResponseBytes, { label: responseLabel });
  let completed = false;
  try {
    while (true) {
      if (signal?.aborted) throw cancelledError(provider);
      if (controller.signal.aborted) throw abortException();
      const { value, done } = await readJsonChunk(reader, { controller, limits, provider });
      if (done) break;
      try {
        collector.append(value);
      } catch (error) {
        if (error.code !== 'byte_limit_exceeded') throw error;
        throw responseLimitError('JSON response', limits.maxRawResponseBytes, error.actualBytes, provider);
      }
    }
    completed = true;
    return collector.toString();
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
  }
}

async function readJsonChunk(reader, { controller, limits, provider }) {
  let timer = null;
  let removeAbort = () => {};
  try {
    const aborted = new Promise((resolve, reject) => {
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
          controller.abort('idle');
          reject(deadlineError('idle', limits.idleTimeoutMs, provider));
        }, limits.idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort();
  }
}

function normalizeJsonRequestError(error, { controller, limits, provider, signal }) {
  if (error instanceof LocalLlmError) return error;
  if (!(error?.name === 'AbortError' || controller.signal.aborted)) return error;
  const reason = controller.signal.reason;
  if (signal?.aborted || reason === 'cancelled') return cancelledError(provider);
  if (reason === 'connection') return deadlineError('connection', limits.connectionTimeoutMs, provider);
  if (reason === 'idle') return deadlineError('idle', limits.idleTimeoutMs, provider);
  return deadlineError('total', limits.totalDeadlineMs, provider);
}

function cancelledError(provider) {
  return new LocalLlmError('Local LLM generation was cancelled.', { code: 'cancelled', provider });
}

function abortException() {
  const error = new Error('The request was aborted.');
  error.name = 'AbortError';
  return error;
}
