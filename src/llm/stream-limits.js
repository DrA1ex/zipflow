import { BoundedByteBuffer, ByteChunkCollector, formatBytes } from '../utils/byte-buffer.js';
import { LocalLlmError } from './errors.js';

export const DEFAULT_LLM_STREAM_LIMITS = Object.freeze({
  connectionTimeoutMs: 15_000,
  totalDeadlineMs: 600_000,
  idleTimeoutMs: 60_000,
  maxSseEventBytes: 2 * 1024 * 1024,
  maxUnparsedBufferBytes: 1 * 1024 * 1024,
  maxReasoningBytes: 4 * 1024 * 1024,
  maxAnswerBytes: 8 * 1024 * 1024,
  maxRawResponseBytes: 2 * 1024 * 1024,
});

export function normalizeLlmStreamLimits(value = {}, { timeoutMs = null } = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    connectionTimeoutMs: positiveLimit(input.connectionTimeoutMs, DEFAULT_LLM_STREAM_LIMITS.connectionTimeoutMs),
    totalDeadlineMs: positiveLimit(input.totalDeadlineMs ?? timeoutMs, DEFAULT_LLM_STREAM_LIMITS.totalDeadlineMs),
    idleTimeoutMs: positiveLimit(input.idleTimeoutMs, DEFAULT_LLM_STREAM_LIMITS.idleTimeoutMs),
    maxSseEventBytes: positiveLimit(input.maxSseEventBytes, DEFAULT_LLM_STREAM_LIMITS.maxSseEventBytes),
    maxUnparsedBufferBytes: positiveLimit(input.maxUnparsedBufferBytes, DEFAULT_LLM_STREAM_LIMITS.maxUnparsedBufferBytes),
    maxReasoningBytes: positiveLimit(input.maxReasoningBytes, DEFAULT_LLM_STREAM_LIMITS.maxReasoningBytes),
    maxAnswerBytes: positiveLimit(input.maxAnswerBytes, DEFAULT_LLM_STREAM_LIMITS.maxAnswerBytes),
    maxRawResponseBytes: positiveLimit(input.maxRawResponseBytes, DEFAULT_LLM_STREAM_LIMITS.maxRawResponseBytes),
  };
}

export class SseEventParser {
  constructor({ maxEventBytes, maxBufferBytes, maxRawBytes, provider = null, onEvent }) {
    this.maxEventBytes = maxEventBytes;
    this.maxBufferBytes = maxBufferBytes;
    this.provider = provider;
    this.onEvent = onEvent;
    this.line = new ByteChunkCollector(maxBufferBytes);
    this.lineBytes = 0;
    this.eventBytes = 0;
    this.eventName = '';
    this.eventData = new ByteChunkCollector(maxEventBytes);
    this.hasEventData = false;
    this.raw = new BoundedByteBuffer(maxRawBytes);
  }

  push(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.raw.append(chunk);
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.appendLineBytes(chunk.subarray(start, index));
      this.eventBytes += 1;
      this.assertLimits();
      this.finishLine();
      start = index + 1;
    }
    if (start < chunk.length) this.appendLineBytes(chunk.subarray(start));
  }

  finish() {
    if (this.lineBytes) this.finishLine();
    if (this.eventName || this.hasEventData) this.flushEvent();
  }

  rawResponse() {
    return this.raw.toString();
  }

  rawResponseTruncated() {
    return this.raw.truncated;
  }

  appendLineBytes(chunk) {
    if (!chunk.length) return;
    this.lineBytes += chunk.length;
    this.eventBytes += chunk.length;
    this.assertLimits();
    this.line.append(chunk);
  }

  assertLimits() {
    if (this.lineBytes > this.maxBufferBytes) {
      throw limitError('sse_buffer_too_large', `The unparsed LLM stream buffer exceeded ${formatBytes(this.maxBufferBytes)}.`, {
        provider: this.provider, limitBytes: this.maxBufferBytes, actualBytes: this.lineBytes,
      });
    }
    if (this.eventBytes > this.maxEventBytes) {
      throw limitError('sse_event_too_large', `An LLM stream event exceeded ${formatBytes(this.maxEventBytes)}.`, {
        provider: this.provider, limitBytes: this.maxEventBytes, actualBytes: this.eventBytes,
      });
    }
  }

  finishLine() {
    let line = this.line.toBuffer();
    this.line = new ByteChunkCollector(this.maxBufferBytes);
    this.lineBytes = 0;
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    if (!line.length) {
      this.flushEvent();
      return;
    }
    const text = line.toString('utf8');
    if (text.startsWith(':')) return;
    const separator = text.indexOf(':');
    const field = separator < 0 ? text : text.slice(0, separator);
    const rawValue = separator < 0 ? '' : text.slice(separator + 1);
    const fieldValue = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event') this.eventName = fieldValue;
    else if (field === 'data') {
      if (this.hasEventData) this.eventData.append('\n');
      this.eventData.append(fieldValue);
      this.hasEventData = true;
    }
  }

  flushEvent() {
    if (this.eventName || this.hasEventData) {
      this.onEvent({ event: this.eventName, data: this.eventData.toString().trim() });
    }
    this.eventName = '';
    this.eventData = new ByteChunkCollector(this.maxEventBytes);
    this.hasEventData = false;
    this.eventBytes = 0;
  }
}

export function outputLimitError(kind, limitBytes, actualBytes, provider = null) {
  const label = kind === 'reasoning' ? 'reasoning output' : 'answer output';
  return limitError('llm_output_too_large', `The local LLM ${label} exceeded ${formatBytes(limitBytes)}.`, {
    provider, outputKind: kind, limitBytes, actualBytes,
  });
}

export function responseLimitError(label, limitBytes, actualBytes, provider = null) {
  return limitError('llm_response_too_large', `The local LLM ${label} exceeded ${formatBytes(limitBytes)}.`, {
    provider, outputKind: 'response', limitBytes, actualBytes,
  });
}

export function deadlineError(kind, milliseconds, provider = null) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  const labels = {
    connection: `The local LLM server did not open a connection within ${seconds} seconds.`,
    total: `The local LLM request exceeded its ${seconds}-second total deadline.`,
    idle: `The local LLM stream produced no data for ${seconds} seconds.`,
  };
  return new LocalLlmError(labels[kind], { code: `llm_${kind}_timeout`, provider });
}

function limitError(code, message, details) {
  return new LocalLlmError(message, { code, ...details });
}

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
