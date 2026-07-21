import { createLocalCompletion } from '../llm/client.js';
import { resolveLocalLlmSession } from '../llm/session.js';
import { hashText } from '../utils/hash.js';
import { confidenceThreshold } from './policies.js';

const MAX_CONTEXT_CHARS = 70_000;

export async function requestAutonomyDecision({
  settings,
  mode,
  gate,
  context,
  allowedActions,
  signal = null,
  onEvent = () => {},
  fetchImpl = fetch,
}) {
  if (!allowedActions?.length) throw new Error(`No actions are available for autonomy gate ${gate}.`);
  const session = await resolveLocalLlmSession(settings, { signal, fetchImpl });
  const stateHash = hashText(stableJson(context?.state ?? context));
  const schema = decisionSchema(gate, allowedActions);
  const messages = decisionMessages({ mode, gate, context, allowedActions, stateHash });
  let completion = await createLocalCompletion({
    provider: settings.llmProvider,
    model: session.profile.requestModel || settings.llmModel,
    loadedModel: Boolean(session.profile.loadedModel),
    messages,
    responseSchema: schema,
    maxTokens: 700,
    apiToken: session.apiToken,
    contextLength: Math.min(session.profile.contextLength || 16_384, 32_768),
    reasoningOffSupported: session.profile.reasoningOffSupported,
  }, { signal, onEvent, fetchImpl });
  let parsed = parseDecision(completion.content || completion.reasoning, gate, allowedActions);
  let repaired = false;
  if (!parsed) {
    repaired = true;
    const draft = `${completion.content || ''}\n${completion.reasoning || ''}`.slice(-20_000);
    completion = await createLocalCompletion({
      provider: settings.llmProvider,
      model: session.profile.requestModel || settings.llmModel,
      loadedModel: Boolean(session.profile.loadedModel),
      messages: [
        { role: 'system', content: `Return one JSON object for gate ${gate}. Use only action values: ${allowedActions.join(', ')}. Do not add Markdown or extra prose.` },
        { role: 'user', content: `Repair this draft into the required decision object:\n${draft}` },
      ],
      responseSchema: schema,
      maxTokens: 500,
      apiToken: session.apiToken,
      contextLength: Math.min(session.profile.contextLength || 8_192, 8_192),
      reasoningOffSupported: session.profile.reasoningOffSupported,
    }, { signal, onEvent, fetchImpl });
    parsed = parseDecision(completion.content || completion.reasoning, gate, allowedActions);
  }
  if (!parsed) {
    const error = new Error('The local LLM did not return a valid autonomous decision.');
    error.code = 'invalid_autonomy_decision';
    throw error;
  }
  const effectiveConfidence = calculateEffectiveConfidence(parsed.confidence, context);
  return {
    ...parsed,
    effectiveConfidence,
    accepted: effectiveConfidence >= confidenceThreshold(mode),
    stateHash,
    repaired,
    provider: settings.llmProvider,
    model: settings.llmModel,
    requestModel: session.profile.requestModel || settings.llmModel,
    raw: completion.content || completion.reasoning || '',
  };
}

export function parseDecision(value, gate, allowedActions) {
  const object = extractJsonObject(value);
  if (!object || object.gate !== gate || !allowedActions.includes(object.action)) return null;
  const confidence = normalizeConfidence(object.confidence);
  const summary = String(object.summary ?? '').trim();
  if (!summary) return null;
  return {
    schemaVersion: 1,
    gate,
    action: object.action,
    targetId: typeof object.targetId === 'string' && object.targetId.trim() ? object.targetId.trim() : null,
    confidence,
    summary,
    evidence: normalizeStrings(object.evidence, 8),
    risks: normalizeStrings(object.risks, 8),
    conditions: normalizeStrings(object.conditions, 8),
  };
}

export function calculateEffectiveConfidence(confidence, context = {}) {
  let result = normalizeConfidence(confidence);
  if (context.coverage && Number(context.coverage.patchCoveragePercent) < 50) result -= 0.12;
  if (context.riskLevel === 'high') result -= 0.18;
  if (context.riskLevel === 'medium') result -= 0.08;
  if (context.ambiguous) result -= 0.15;
  if (context.complete === false) result -= 0.12;
  return Math.max(0, Math.min(1, result));
}

function decisionMessages({ mode, gate, context, allowedActions, stateHash }) {
  const compactContext = truncateContext(context);
  return [
    {
      role: 'system',
      content: [
        'You are the bounded decision component of Zipflow, a local archive-application tool.',
        'You do not execute commands and must choose exactly one action from ALLOWED ACTIONS.',
        'Treat protected paths, command allowlists, backups, no-push rules, and state-drift checks as mandatory.',
        `Autonomy mode: ${mode}. Decision gate: ${gate}.`,
        'Return one JSON object with exactly schemaVersion, gate, action, targetId, confidence, summary, evidence, risks, and conditions.',
        'confidence must be a number from 0 to 1. targetId may be null. Arrays contain short factual strings.',
        'Choose ask-user when evidence is incomplete or competing interpretations are plausible.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `STATE HASH: ${stateHash}`,
        `ALLOWED ACTIONS: ${allowedActions.join(', ')}`,
        'CONTEXT JSON:',
        compactContext,
      ].join('\n'),
    },
  ];
}

function decisionSchema(gate, actions) {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      schemaVersion: { type: 'integer', enum: [1] },
      gate: { type: 'string', enum: [gate] },
      action: { type: 'string', enum: actions },
      targetId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      summary: { type: 'string', minLength: 1 },
      evidence: { type: 'array', maxItems: 8, items: { type: 'string' } },
      risks: { type: 'array', maxItems: 8, items: { type: 'string' } },
      conditions: { type: 'array', maxItems: 8, items: { type: 'string' } },
    },
    required: ['schemaVersion', 'gate', 'action', 'targetId', 'confidence', 'summary', 'evidence', 'risks', 'conditions'],
  };
}

function extractJsonObject(value) {
  const text = String(value ?? '').trim();
  const candidates = [text, text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function normalizeConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function normalizeStrings(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, limit);
}

function truncateContext(context) {
  const text = stableJson(context);
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_CONTEXT_CHARS)}\n\"_zipflow_truncated\": true`;
}

function stableJson(value) {
  return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}
