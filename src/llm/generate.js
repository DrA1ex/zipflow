import { createLocalCompletion } from './client.js';
import { getLocalModelProfile } from './model-info.js';
import {
  createPromptBudget, fitPatchToBudget, reducePatchBudget,
} from './patch-budget.js';

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
    commitMessage: { type: 'string', minLength: 1 },
  },
  required: ['summary', 'commitMessage'],
};

const REVIEW_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...RESPONSE_SCHEMA.properties,
    assessment: { type: 'string', enum: ['suitable', 'suspicious', 'unsuitable'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasons: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
  },
  required: ['summary', 'commitMessage', 'assessment', 'confidence', 'reasons'],
};

const MAX_REPAIR_DRAFT_CHARS = 40_000;
const GENERATION_ATTEMPTS = 3;

export function isLocalLlmEnabled(settings) {
  return ['ollama', 'lmstudio'].includes(settings?.llmProvider) && Boolean(settings?.llmModel);
}

export async function generateChangeDescription({ settings, project, plan, patchContent }, options = {}) {
  if (!isLocalLlmEnabled(settings)) return null;
  const notify = options.onEvent ?? (() => {});
  const language = settings.llmLanguage || 'English';
  const reviewArchive = settings.llmArchiveReview === 'patch';
  const responseSchema = reviewArchive ? REVIEW_RESPONSE_SCHEMA : RESPONSE_SCHEMA;
  const system = buildSystemPrompt(language, reviewArchive);
  const fixedUser = buildUserPrompt(project, plan, '');
  notify({ type: 'phase', phase: 'model-info', label: 'Reading the selected model context limit' });
  const profile = await getLocalModelProfile(settings.llmProvider, settings.llmModel, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.metadataTimeoutMs ?? 10_000,
    apiToken: settings.llmApiToken,
    signal: options.signal,
  });
  notify({ type: 'model-profile', profile });
  const budget = createPromptBudget({
    contextLength: profile.contextLength,
    fixedPrompt: `${system}\n${fixedUser}`,
    requestedOutputTokens: 1_024,
  });
  let patchTokens = budget.patchTokens;
  const attempts = [];
  let first = null;
  let lastError = null;

  for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt += 1) {
    const fitted = fitPatchToBudget(patchContent, patchTokens);
    attempts.push({ attempt, patch: fitted, budgetTokens: patchTokens });
    notify({ type: 'patch-budget', attempt, profile, budget, patch: fitted });
    notify({
      type: 'phase',
      phase: attempt === 1 ? 'requesting' : 'retrying-smaller',
      label: attempt === 1 ? 'Sending the patch to the local model' : 'Retrying with a smaller patch excerpt',
    });
    try {
      first = await requestCompletion({
        settings,
        model: profile.requestModel,
        loadedModel: profile.loadedModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: buildUserPrompt(project, plan, fitted.content) },
        ],
        maxTokens: budget.outputTokens,
        contextLength: budget.effectiveContextTokens,
        reasoningOffSupported: profile.reasoningOffSupported,
        responseSchema,
      }, {
        ...options,
        onEvent: (event) => notify({ ...event, stage: 'generation' }),
      });
      attempts[attempts.length - 1].completion = completionDiagnostics(first);
      break;
    } catch (error) {
      lastError = error;
      attempts[attempts.length - 1].error = errorDiagnostics(error);
      if (!error.retryableWithSmallerPrompt || attempt === GENERATION_ATTEMPTS) break;
      patchTokens = reducePatchBudget(patchTokens, error.code);
      notify({ type: 'smaller-retry', reason: error.code, message: error.message, patchTokens });
    }
  }

  if (!first) {
    attachDiagnostics(lastError, { profile, budget, attempts });
    throw lastError;
  }

  const direct = tryStructured(first.content, reviewArchive) ?? tryStructured(first.reasoning, reviewArchive);
  if (direct) return resultWithDiagnostics(direct, first, { profile, budget, attempts, repaired: false });

  notify({ type: 'phase', phase: 'repairing', label: 'Formatting the model draft as structured JSON' });
  const draft = [first.content, first.reasoning].filter(Boolean).join('\n\n').slice(-MAX_REPAIR_DRAFT_CHARS);
  if (draft) {
    try {
      const repaired = await requestCompletion({
        settings,
        model: profile.requestModel,
        loadedModel: profile.loadedModel,
        maxTokens: 512,
        contextLength: Math.min(budget.effectiveContextTokens, 8_192),
        reasoningOffSupported: profile.reasoningOffSupported,
        responseSchema,
        messages: [
          {
            role: 'system',
            content: repairPrompt(language, reviewArchive),
          },
          { role: 'user', content: `DRAFT START\n${draft}\nDRAFT END` },
        ],
      }, {
        ...options,
        onEvent: (event) => notify({ ...event, stage: 'repair' }),
      });
      const parsed = tryStructured(repaired.content, reviewArchive) ?? tryStructured(repaired.reasoning, reviewArchive);
      if (parsed) {
        return resultWithDiagnostics(parsed, repaired, {
          profile, budget, attempts, repaired: true, originalFinishReason: first.finishReason,
          original: completionDiagnostics(first),
        });
      }
      attempts.push({ attempt: 'repair', completion: completionDiagnostics(repaired) });
    } catch (error) {
      attempts.push({ attempt: 'repair', error: errorDiagnostics(error) });
    }
  }

  const partial = extractUnstructured(first.content || first.reasoning);
  if (partial.summary.length) {
    return {
      summary: partial.summary,
      commitMessage: partial.commitMessage,
      warning: partial.commitMessage
        ? 'The local model returned unstructured output; Zipflow extracted the visible summary and commit message.'
        : 'The local model returned unstructured output; Zipflow extracted the summary and will use a commit-message fallback.',
      diagnostics: {
        profile, budget, attempts, finishReason: first.finishReason,
        chunks: first.chunks, repaired: false, partial: true,
      },
      raw: completionDiagnostics(first, true),
    };
  }

  const error = new Error(noOutputMessage(first));
  error.code = 'no_usable_output';
  error.diagnostics = { profile, budget, attempts, completion: completionDiagnostics(first, true) };
  throw error;
}

export function parseResponse(content, { requireAssessment = false } = {}) {
  const parsed = parseJsonObject(content);
  const summary = normalizeSummary(parsed.summary ?? parsed.changeSummary ?? parsed.change_summary);
  const commitMessage = normalizeCommitMessage(
    parsed.commitMessage ?? parsed.commit_message ?? parsed.commit ?? parsed.message,
  );
  if (!summary.length || !commitMessage) throw new Error('Local LLM response is missing summary or commitMessage.');
  const assessment = normalizeAssessment(parsed);
  if (requireAssessment && !assessment) throw new Error('Local LLM response is missing archive assessment fields.');
  return { summary, commitMessage, ...(assessment ?? {}) };
}

export function extractUnstructured(content) {
  const lines = String(content ?? '').split('\n').map(cleanLine).filter(Boolean);
  const summaryStart = findLastHeading(lines, /^(summary|summary \(.+\)|сводка|краткое описание)\s*:?$/i);
  const source = summaryStart >= 0 ? lines.slice(summaryStart + 1) : lines;
  const summary = [];
  let commitMessage = '';
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    if (/^(commit message|сообщение коммита)(\s*\(.+\))?\s*:?$/i.test(line)) {
      commitMessage = findCommitLine(source.slice(index + 1));
      break;
    }
    if (/^(subject|тема)\s*:/i.test(line)) {
      commitMessage ||= line.replace(/^(subject|тема)\s*:\s*/i, '').trim();
      continue;
    }
    if (summary.length < 5 && isUsefulSummaryLine(line)) summary.push(line);
  }
  return { summary: [...new Set(summary)].slice(0, 5), commitMessage: normalizeCommitMessage(commitMessage) };
}

function buildSystemPrompt(language, reviewArchive = false) {
  return [
    'You analyze source-code patches for a developer workflow tool.',
    reviewArchive
      ? 'Return only one JSON object with exactly summary, commitMessage, assessment, confidence, and reasons.'
      : 'Return only one JSON object with exactly summary and commitMessage.',
    'Do not use Markdown fences, commentary, or extra keys. Do not reveal internal reasoning or repeat the patch.',
    `Write both summary and commitMessage in ${language}.`,
    'The summary must contain 1-5 concise factual lines. Mention behavior, architecture, tests, or risks only when visible in the patch.',
    'The commit message must be ready for git commit: imperative subject, preferably under 72 characters, with an optional concise body separated by a blank line.',
    'Do not invent changes, test results, issue numbers, or motivations not supported by the patch.',
    ...(reviewArchive ? [
      'Assess whether the archive changes plausibly belong to this project. Use assessment suitable, suspicious, or unsuitable.',
      'Use unsuitable only for strong evidence of a wrong archive or unrelated project. Use suspicious for ambiguous, destructive, or unexpectedly broad changes.',
      'Write 1-5 concise reasons in the requested language; assessment and confidence remain English enum values.',
      'This is advisory: do not claim that tests passed or that deterministic safety checks can be skipped.',
    ] : []),
  ].join(' ');
}

function buildUserPrompt(project, plan, patch) {
  return [
    `Project: ${project.name}`,
    `Project types: ${(project.labels ?? []).join(', ') || 'unknown'}`,
    `Plan counts: created=${plan.counts.created}, updated=${plan.counts.updated}, deleted=${plan.counts.deleted}`,
    'Changed paths:', ...changePathLines(plan),
    '', 'PATCH START', patch, 'PATCH END',
  ].join('\n');
}

function normalizeAssessment(parsed) {
  const assessment = String(parsed.assessment ?? parsed.verdict ?? '').toLowerCase();
  const confidence = String(parsed.confidence ?? '').toLowerCase();
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.map((line) => String(line).trim()).filter(Boolean).slice(0, 5)
    : [];
  if (!['suitable', 'suspicious', 'unsuitable'].includes(assessment) || !reasons.length) return null;
  return {
    assessment,
    confidence: ['low', 'medium', 'high'].includes(confidence) ? confidence : 'low',
    reasons,
  };
}

function changePathLines(plan) {
  const values = [
    ...(plan.created ?? []).map((item) => `CREATE ${item.path}`),
    ...(plan.updated ?? []).map((item) => `UPDATE ${item.path}`),
    ...(plan.deleted ?? []).map((item) => `DELETE ${item.path}`),
  ];
  const limit = 5_000;
  const selected = values.slice(0, limit);
  if (values.length > limit) selected.push(`… ${values.length - limit} additional changed paths omitted`);
  return selected.length ? selected : ['(none)'];
}

function repairPrompt(language, reviewArchive = false) {
  return [
    reviewArchive
      ? 'Convert the supplied draft into one JSON object with exactly summary, commitMessage, assessment, confidence, and reasons.'
      : 'Convert the supplied draft into one JSON object with exactly summary and commitMessage.',
    'Return JSON only. Do not add analysis, Markdown, or extra keys.',
    `Write summary and commitMessage in ${language}.`,
    'Keep the summary factual and concise. The commit message must be ready for git commit.',
    ...(reviewArchive ? ['Preserve the draft archive verdict using assessment suitable, suspicious, or unsuitable, confidence low/medium/high, and 1-5 reasons.'] : []),
  ].join(' ');
}

function requestCompletion({ settings, model, loadedModel, messages, maxTokens, contextLength, reasoningOffSupported, responseSchema }, options) {
  return createLocalCompletion({
    provider: settings.llmProvider,
    model: model || settings.llmModel,
    loadedModel: Boolean(loadedModel),
    messages,
    responseSchema: responseSchema ?? RESPONSE_SCHEMA,
    maxTokens,
    apiToken: settings.llmApiToken,
    contextLength,
    reasoningOffSupported,
  }, options);
}

function tryStructured(content, requireAssessment = false) {
  try {
    return parseResponse(content, { requireAssessment });
  } catch {
    return null;
  }
}

function parseJsonObject(content) {
  const source = String(content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Local LLM returned invalid JSON.');
    return JSON.parse(source.slice(start, end + 1));
  }
}

function resultWithDiagnostics(value, completion, extra) {
  return {
    ...value,
    diagnostics: {
      finishReason: completion.finishReason,
      chunks: completion.chunks,
      usage: completion.usage,
      ...extra,
    },
    raw: completionDiagnostics(completion, true),
  };
}

function normalizeSummary(value) {
  if (typeof value === 'string') return value.split(/\n+/).map(cleanLine).filter(Boolean).slice(0, 5);
  return Array.isArray(value) ? value.map((line) => String(line).trim()).filter(Boolean).slice(0, 5) : [];
}

function normalizeCommitMessage(value) {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  if (!result || looksLikeJson(result)) return '';
  return result;
}

function looksLikeJson(value) {
  if (!/^[\[{]/.test(value)) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function completionDiagnostics(completion, includeOutput = false) {
  return {
    finishReason: completion.finishReason,
    chunks: completion.chunks,
    usage: completion.usage,
    contentLength: completion.content?.length ?? 0,
    reasoningLength: completion.reasoning?.length ?? 0,
    ...(includeOutput ? { content: completion.content ?? '', reasoning: completion.reasoning ?? '' } : {}),
  };
}

function errorDiagnostics(error) {
  return {
    name: error.name,
    message: error.message,
    code: error.code ?? null,
    status: error.status ?? null,
    retryableWithSmallerPrompt: Boolean(error.retryableWithSmallerPrompt),
    responseBody: error.responseBody ?? null,
  };
}

function attachDiagnostics(error, diagnostics) {
  if (error && typeof error === 'object') error.diagnostics = { ...(error.diagnostics ?? {}), ...diagnostics };
}

function noOutputMessage(completion) {
  if (!completion.content && !completion.reasoning) {
    return 'The local model completed without returning text. Zipflow saved the raw response diagnostics.';
  }
  if (completion.finishReason === 'length') {
    return 'The local model reached its output limit without producing a usable summary or commit message.';
  }
  return 'The local model returned text, but it did not contain a usable summary or commit message.';
}

function cleanLine(value) {
  return String(value).trim().replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^`+|`+$/g, '').trim();
}

function findLastHeading(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index -= 1) if (pattern.test(lines[index])) return index;
  return -1;
}

function findCommitLine(lines) {
  for (const line of lines) {
    if (/^(subject|тема)\s*:/i.test(line)) return line.replace(/^(subject|тема)\s*:\s*/i, '').trim();
    if (!/^(body|тело)\s*:/i.test(line) && line.length <= 200) return line;
  }
  return '';
}

function isUsefulSummaryLine(line) {
  if (line.length < 8 || line.length > 300) return false;
  if (/^(commit message|subject|body|сообщение коммита|тема|тело)\s*:?/i.test(line)) return false;
  if (/^(summary|сводка)\s*:?$/i.test(line)) return false;
  return true;
}
