import path from 'node:path';
import { readJson, writeJsonAtomic } from '../utils/fs.js';
import { ensureZipflowHome, getZipflowHome } from '../workflow/store.js';
import { withStorageLease } from '../storage/lease.js';
import { estimateTokens } from './delivery.js';

const STATS_VERSION = 1;
const FILE_NAME = 'llm-token-stats.json';

export function emptyLlmTokenStats(now = new Date()) {
  const timestamp = now.toISOString();
  return {
    version: STATS_VERSION,
    resetAt: timestamp,
    updatedAt: null,
    totals: emptyCounters(),
    providers: {},
  };
}

export async function loadLlmTokenStats() {
  await ensureZipflowHome();
  return normalizeStats(await readJson(statsPath(), null));
}

export async function recordLlmTokenUsage({
  provider, model, messages, completion, requestCount = 1, outputCharacters = null,
  normalizedUsage = null, now = new Date(),
}) {
  const usage = normalizedUsage ?? normalizeCompletionUsage(completion?.usage, {
    messages, completion, requestCount, outputCharacters,
  });
  return withStorageLease('llm-token-stats', async () => {
    const current = normalizeStats(await readJson(statsPath(), null));
    const providerId = String(provider || 'unknown');
    const modelId = String(model || 'unknown');
    current.providers[providerId] ??= { ...emptyCounters(), models: {} };
    current.providers[providerId].models[modelId] ??= emptyCounters();
    addUsage(current.totals, usage);
    addUsage(current.providers[providerId], usage);
    addUsage(current.providers[providerId].models[modelId], usage);
    current.updatedAt = now.toISOString();
    await writeJsonAtomic(statsPath(), current);
    return current;
  });
}

export async function resetLlmTokenStats({ now = new Date() } = {}) {
  return withStorageLease('llm-token-stats', async () => {
    await ensureZipflowHome();
    const value = emptyLlmTokenStats(now);
    await writeJsonAtomic(statsPath(), value);
    return value;
  });
}

export function normalizeCompletionUsage(rawUsage, {
  messages = [], completion = {}, requestCount = 1, outputCharacters = null,
} = {}) {
  const usage = unwrapUsage(rawUsage);
  const input = firstNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const output = firstNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  const requests = Math.max(1, nonNegativeInteger(requestCount) ?? 1);
  const estimatedInput = estimateMessageTokens(messages);
  const exact = input !== null && output !== null;
  return {
    requests,
    inputTokens: (input ?? estimatedInput) + (estimatedInput * Math.max(0, requests - 1)),
    outputTokens: output ?? estimateCompletionTokens(completion, outputCharacters),
    exactRequests: exact ? 1 : 0,
    estimatedRequests: requests - (exact ? 1 : 0),
  };
}

export function createLlmTokenTracker({ enabled, provider, model, messages, onEvent = () => {} }) {
  let requestCount = 0;
  let outputCharacters = 0;
  const emit = (event) => {
    if (event?.type === 'request') requestCount += 1;
    if (event?.type === 'chunk') {
      outputCharacters += String(event.contentDelta ?? '').length + String(event.reasoningDelta ?? '').length;
    }
    onEvent(event);
  };
  const persist = async (completion, { failed = false } = {}) => {
    if (requestCount < 1) return;
    const value = completion ?? { content: '', reasoning: '', usage: null };
    const usage = normalizeCompletionUsage(value.usage, {
      messages, completion: value, requestCount,
      outputCharacters: failed ? outputCharacters : null,
    });
    onEvent({ type: 'token-usage', provider, model, usage, failed });
    if (!enabled) return;
    try {
      await recordLlmTokenUsage({
        provider, model, messages, completion: value, requestCount,
        outputCharacters: failed ? outputCharacters : null,
        normalizedUsage: usage,
      });
    } catch (error) {
      onEvent({ type: 'token-stats-error', error: error?.message ?? String(error) });
    }
  };
  return {
    onEvent: emit,
    complete: (completion) => persist(completion),
    fail: (error) => persist({
      content: '', reasoning: '',
      usage: error?.usage ?? error?.diagnostics?.usage ?? null,
    }, { failed: true }),
  };
}

export function emptyLlmUsageCounters() {
  return emptyCounters();
}

export function mergeLlmUsageCounters(target, usage = {}) {
  const result = target ?? emptyCounters();
  addUsage(result, usage);
  return result;
}

function unwrapUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return {};
  return rawUsage.last
    ?? rawUsage.lastTokenUsage
    ?? rawUsage.last_token_usage
    ?? rawUsage.usage
    ?? rawUsage;
}

function estimateMessageTokens(messages) {
  return (messages ?? []).reduce((total, message) => total + estimateTokens(`${message?.role ?? 'user'}\n${message?.content ?? ''}`), 0);
}

function estimateCompletionTokens(completion, outputCharacters = null) {
  const value = [completion?.reasoning, completion?.content].filter(Boolean).join('\n');
  if (value) return estimateTokens(value);
  const characters = nonNegativeInteger(outputCharacters);
  return characters ? Math.max(1, Math.ceil(characters / 3.5)) : 0;
}

function firstNumber(value, keys) {
  for (const key of keys) {
    const number = nonNegativeInteger(value?.[key]);
    if (number !== null) return number;
  }
  return null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function addUsage(target, usage) {
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'exactRequests', 'estimatedRequests']) {
    target[key] = nonNegativeInteger(target[key]) ?? 0;
    target[key] += usage[key] ?? 0;
  }
}

function normalizeStats(value) {
  const source = value && typeof value === 'object' ? value : emptyLlmTokenStats();
  const result = {
    version: STATS_VERSION,
    resetAt: validTimestamp(source.resetAt) ?? new Date().toISOString(),
    updatedAt: validTimestamp(source.updatedAt),
    totals: normalizeCounters(source.totals),
    providers: {},
  };
  for (const [provider, entry] of Object.entries(source.providers ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const normalized = { ...normalizeCounters(entry), models: {} };
    for (const [model, counters] of Object.entries(entry.models ?? {})) {
      normalized.models[model] = normalizeCounters(counters);
    }
    result.providers[provider] = normalized;
  }
  return result;
}

function normalizeCounters(value = {}) {
  return Object.fromEntries(['requests', 'inputTokens', 'outputTokens', 'exactRequests', 'estimatedRequests']
    .map((key) => [key, nonNegativeInteger(value?.[key]) ?? 0]));
}

function emptyCounters() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, exactRequests: 0, estimatedRequests: 0 };
}

function validTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function statsPath() {
  return path.join(getZipflowHome(), FILE_NAME);
}
