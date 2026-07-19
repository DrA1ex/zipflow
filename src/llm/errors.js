export class LocalLlmError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LocalLlmError';
    this.code = details.code ?? 'llm_error';
    this.status = details.status ?? null;
    this.provider = details.provider ?? null;
    this.retryableWithSmallerPrompt = Boolean(details.retryableWithSmallerPrompt);
    this.responseBody = details.responseBody ?? null;
    this.diagnostics = details.diagnostics ?? null;
  }
}

export function normalizeServerError(value, fallback = 'Local LLM request failed.') {
  if (!value) return fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    try {
      return normalizeServerError(JSON.parse(trimmed), trimmed);
    } catch {
      return trimmed;
    }
  }
  const error = value.error ?? value;
  if (typeof error === 'string') return error.trim() || fallback;
  return String(error.message ?? error.detail ?? error.type ?? fallback).trim();
}

export function classifyServerError(message, { status = null, provider = null, responseBody = null } = {}) {
  const text = String(message ?? '').trim();
  const lower = text.toLowerCase();
  if (/exceeds? the available context|context size|context length|too many tokens|prompt.*too long/.test(lower)) {
    return new LocalLlmError(`The local LLM prompt exceeded the model context window. ${text}`.trim(), {
      code: 'context_exceeded', status, provider, responseBody, retryableWithSmallerPrompt: true,
    });
  }
  if (/insufficient memory|out of memory|compute error|failed to decode|gpu.*memory/.test(lower)) {
    return new LocalLlmError(`The local LLM ran out of memory while processing the patch. ${text}`.trim(), {
      code: 'out_of_memory', status, provider, responseBody, retryableWithSmallerPrompt: true,
    });
  }
  return new LocalLlmError(text || 'Local LLM request failed.', {
    code: status ? `http_${status}` : 'server_error', status, provider, responseBody,
  });
}
