import { createLocalCompletion } from './client.js';
import { resolveLocalLlmSession } from './session.js';
import { createPromptBudget, fitPatchToBudget, reducePatchBudget } from './patch-budget.js';
import {
  createChangeList, createPatchBatches, estimateTokens, resolveDeliveryMode,
} from './delivery.js';
import {
  extractUnstructuredResponse, parseChangeResponse, readableResponseInstructions,
} from './response.js';

const RESPONSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
    commitMessage: { type: 'string', minLength: 1 },
  },
  required: ['summary', 'commitMessage'],
};
const REVIEW_RESPONSE_SCHEMA = {
  ...RESPONSE_SCHEMA,
  properties: {
    ...RESPONSE_SCHEMA.properties,
    assessment: { type: 'string', enum: ['suitable', 'suspicious', 'unsuitable'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasons: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
  },
  required: [...RESPONSE_SCHEMA.required, 'assessment', 'confidence', 'reasons'],
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
  const fixedUser = buildUserPrompt(project, plan, { kind: 'change-list', content: createChangeList(plan) });
  let session = options.session;
  if (!session) {
    notify({ type: 'phase', phase: 'model-info', label: 'Reading the selected model context limit' });
    session = await resolveLocalLlmSession(settings, {
      fetchImpl: options.fetchImpl, timeoutMs: options.metadataTimeoutMs ?? 10_000, signal: options.signal,
    });
    notify({ type: 'model-profile', profile: session.profile });
  }
  const profile = session.profile;
  const budget = createPromptBudget({
    contextLength: profile.contextLength,
    fixedPrompt: `${system}\n${fixedUser}`,
    requestedOutputTokens: 1_024,
  });
  const requestedMode = settings.llmChangeDelivery || 'patch';
  const deliveryMode = resolveDeliveryMode(requestedMode, {
    patchEstimatedTokens: estimateTokens(patchContent), patchBudgetTokens: budget.patchTokens,
  });
  notify({ type: 'delivery-mode', requestedMode, deliveryMode });
  const generation = deliveryMode === 'chunked'
    ? await generateChunked({ settings, project, plan, patchContent, profile, budget, system, reviewArchive }, options, notify)
    : deliveryMode === 'change-list'
      ? await generateFromChangeList({ settings, project, plan, profile, budget, system }, options, notify)
      : await generateFromPatch({ settings, project, plan, patchContent, profile, budget, system }, options, notify);

  const completion = generation.completion;
  const direct = tryReadable(completion.content, reviewArchive) ?? tryReadable(completion.reasoning, reviewArchive);
  if (direct) return resultWithDiagnostics(direct, completion, {
    profile, budget, delivery: generation.delivery, attempts: generation.attempts, repaired: false,
  });

  notify({ type: 'phase', phase: 'repairing', label: 'Formatting the model response for Zipflow' });
  const draft = [completion.content, completion.reasoning].filter(Boolean).join('\n\n').slice(-MAX_REPAIR_DRAFT_CHARS);
  if (draft) {
    try {
      const repaired = await requestCompletion({
        settings, profile, maxTokens: 512,
        contextLength: Math.min(budget.effectiveContextTokens, 8_192),
        responseSchema,
        messages: [
          { role: 'system', content: repairPrompt(language, reviewArchive) },
          { role: 'user', content: `DRAFT START\n${draft}\nDRAFT END` },
        ],
      }, options, (event) => notify({ ...event, stage: 'repair', hiddenOutput: true }));
      const parsed = tryReadable(repaired.content, reviewArchive) ?? tryReadable(repaired.reasoning, reviewArchive);
      if (parsed) return resultWithDiagnostics(parsed, repaired, {
        profile, budget, delivery: generation.delivery, attempts: generation.attempts,
        repaired: true, originalFinishReason: completion.finishReason,
        original: completionDiagnostics(completion),
      });
      generation.attempts.push({ attempt: 'repair', completion: completionDiagnostics(repaired) });
    } catch (error) {
      generation.attempts.push({ attempt: 'repair', error: errorDiagnostics(error) });
    }
  }

  const partial = extractUnstructuredResponse(completion.content || completion.reasoning);
  if (partial.summary.length) return {
    ...partial,
    warning: partial.commitMessage
      ? 'The local model returned an unexpected text format; Zipflow extracted its visible summary and commit message.'
      : 'The local model returned an unexpected text format; Zipflow extracted the summary and will use a commit-message fallback.',
    diagnostics: {
      profile, budget, delivery: generation.delivery, attempts: generation.attempts,
      finishReason: completion.finishReason, chunks: completion.chunks, repaired: false, partial: true,
    },
    raw: completionDiagnostics(completion, true),
  };

  const error = new Error(noOutputMessage(completion));
  error.code = 'no_usable_output';
  error.diagnostics = {
    profile, budget, delivery: generation.delivery, attempts: generation.attempts,
    completion: completionDiagnostics(completion, true),
  };
  throw error;
}


async function generateFromPatch(context, options, notify) {
  let patchTokens = context.budget.patchTokens;
  const attempts = [];
  let completion = null;
  let lastError = null;
  for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt += 1) {
    const fitted = fitPatchToBudget(context.patchContent, patchTokens);
    attempts.push({ attempt, patch: fitted, budgetTokens: patchTokens });
    notify({ type: 'patch-budget', attempt, profile: context.profile, budget: context.budget, patch: fitted });
    notify({ type: 'phase', phase: attempt === 1 ? 'requesting' : 'retrying-smaller', label: attempt === 1 ? 'Sending the patch to the local model' : 'Retrying with a smaller patch excerpt' });
    try {
      completion = await requestCompletion({
        settings: context.settings, profile: context.profile,
        maxTokens: context.budget.outputTokens,
        contextLength: context.budget.effectiveContextTokens,
        messages: [
          { role: 'system', content: context.system },
          { role: 'user', content: buildUserPrompt(context.project, context.plan, { kind: 'patch', content: fitted.content }) },
        ],
      }, options, (event) => notify({ ...event, stage: 'generation' }));
      attempts.at(-1).completion = completionDiagnostics(completion);
      break;
    } catch (error) {
      lastError = error;
      attempts.at(-1).error = errorDiagnostics(error);
      if (!error.retryableWithSmallerPrompt || attempt === GENERATION_ATTEMPTS) break;
      patchTokens = reducePatchBudget(patchTokens, error.code);
      notify({ type: 'smaller-retry', reason: error.code, message: error.message, patchTokens });
    }
  }
  if (!completion) {
    attachDiagnostics(lastError, { profile: context.profile, budget: context.budget, attempts });
    throw lastError;
  }
  return { completion, attempts, delivery: { requested: context.settings.llmChangeDelivery, resolved: 'patch' } };
}

async function generateFromChangeList(context, options, notify) {
  const changeList = createChangeList(context.plan);
  notify({ type: 'change-list', paths: changedCount(context.plan) });
  const completion = await requestCompletion({
    settings: context.settings, profile: context.profile,
    maxTokens: context.budget.outputTokens,
    contextLength: context.budget.effectiveContextTokens,
    messages: [
      { role: 'system', content: context.system },
      { role: 'user', content: buildUserPrompt(context.project, context.plan, { kind: 'change-list', content: changeList }) },
    ],
  }, options, (event) => notify({ ...event, stage: 'generation' }));
  return {
    completion,
    attempts: [{ attempt: 1, completion: completionDiagnostics(completion) }],
    delivery: { requested: context.settings.llmChangeDelivery, resolved: 'change-list', paths: changedCount(context.plan) },
  };
}

async function generateChunked(context, options, notify) {
  const maxBatchTokens = Math.max(1_500, Math.min(5_000, Math.floor(context.budget.patchTokens * 0.45)));
  const batches = createPatchBatches(context.patchContent, { maxEstimatedTokens: maxBatchTokens });
  const notes = [];
  const attempts = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = { ...batches[index], index: index + 1 };
    notify({ type: 'batch-start', index: batch.index, total: batches.length, files: batch.files });
    const chunkResult = await requestChunkBatch(context, batch, batches.length, options, notify);
    const completion = chunkResult.completion;
    const visible = (completion.content || completion.reasoning).trim();
    notes.push(`BATCH ${batch.index}/${batches.length} · ${batch.files.join(', ')}\n${visible || '(No model notes returned.)'}`);
    attempts.push(...chunkResult.attempts);
    notify({ type: 'batch-complete', index: batch.index, total: batches.length, files: batch.files });
  }
  notify({ type: 'phase', phase: 'synthesis', label: 'Combining file-by-file notes into the final response' });
  const completion = await requestCompletion({
    settings: context.settings, profile: context.profile,
    maxTokens: context.budget.outputTokens,
    contextLength: context.budget.effectiveContextTokens,
    messages: [
      { role: 'system', content: context.system },
      { role: 'user', content: buildSynthesisPrompt(context.project, context.plan, notes) },
    ],
  }, options, (event) => notify({ ...event, stage: 'synthesis' }));
  attempts.push({ attempt: 'synthesis', completion: completionDiagnostics(completion) });
  return {
    completion, attempts,
    delivery: {
      requested: context.settings.llmChangeDelivery, resolved: 'chunked',
      batches: batches.length, files: [...new Set(batches.flatMap((batch) => batch.files))].length,
    },
  };
}


async function requestChunkBatch(context, batch, total, options, notify) {
  let tokenBudget = Math.max(800, batch.estimatedTokens);
  const attempts = [];
  let lastError = null;
  for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt += 1) {
    const fitted = fitPatchToBudget(batch.content, tokenBudget);
    try {
      const completion = await requestCompletion({
        settings: context.settings, profile: context.profile, maxTokens: 512,
        contextLength: Math.min(context.budget.effectiveContextTokens, 12_000),
        messages: [
          { role: 'system', content: chunkPrompt(context.settings.llmLanguage || 'English') },
          { role: 'user', content: `BATCH ${batch.index}/${total}\nFILES:\n${batch.files.map((file) => `- ${file}`).join('\n')}\n\nPATCH:\n${fitted.content}` },
        ],
      }, options, (event) => notify({
        ...event, stage: 'chunk-analysis', batchIndex: batch.index, batchTotal: total,
      }));
      attempts.push({
        attempt: `batch-${batch.index}.${attempt}`, files: batch.files,
        patch: fitted, completion: completionDiagnostics(completion),
      });
      return { completion, attempts };
    } catch (error) {
      lastError = error;
      attempts.push({
        attempt: `batch-${batch.index}.${attempt}`, files: batch.files,
        patch: fitted, error: errorDiagnostics(error),
      });
      if (!error.retryableWithSmallerPrompt || attempt === GENERATION_ATTEMPTS) break;
      tokenBudget = reducePatchBudget(tokenBudget, error.code);
      notify({
        type: 'smaller-retry', reason: error.code, message: error.message,
        patchTokens: tokenBudget, batchIndex: batch.index, batchTotal: total,
      });
    }
  }
  attachDiagnostics(lastError, { delivery: 'chunked', batch: batch.index, attempts });
  throw lastError;
}

function buildSystemPrompt(language, reviewArchive = false) {
  return [
    'You analyze source-code patches and other source-code change representations for a developer workflow tool.',
    'Be factual and concise. Mention behavior, architecture, tests, or risks only when supported by the supplied information.',
    'Do not invent test results, issue numbers, or motivations.',
    ...(reviewArchive ? [
      'Assess whether the archive changes plausibly belong to this project and return assessment suitable, suspicious, or unsuitable.',
      'Use unsuitable only for strong evidence of a wrong archive. Use suspicious for ambiguous, destructive, or unexpectedly broad changes.',
      'This assessment is advisory and never replaces deterministic safety checks.',
    ] : []),
    readableResponseInstructions(language, { assessment: reviewArchive }),
  ].join('\n\n');
}

function buildUserPrompt(project, plan, payload) {
  const intro = [
    `Project: ${project.name}`,
    `Project types: ${(project.labels ?? []).join(', ') || 'unknown'}`,
    `Plan counts: created=${plan.counts.created}, updated=${plan.counts.updated}, deleted=${plan.counts.deleted}`,
  ];
  if (payload.kind === 'patch') return [...intro, '', 'CHANGED PATHS:', createChangeList(plan), '', 'PATCH START', payload.content, 'PATCH END'].join('\n');
  return [...intro, '', 'CHANGED PATHS:', payload.content, '', 'No file contents are provided. Base the response only on path-level evidence and clearly avoid content-specific claims.'].join('\n');
}

function buildSynthesisPrompt(project, plan, notes) {
  return [
    `Project: ${project.name}`,
    `Project types: ${(project.labels ?? []).join(', ') || 'unknown'}`,
    `Plan counts: created=${plan.counts.created}, updated=${plan.counts.updated}, deleted=${plan.counts.deleted}`,
    '', 'COMPLETE CHANGED PATH LIST:', createChangeList(plan),
    '', 'FILE-BATCH ANALYSIS NOTES:', notes.join('\n\n---\n\n'),
    '', 'Create the final response now. Reconcile duplicated notes and do not claim that tests passed.',
  ].join('\n');
}

function chunkPrompt(language) {
  return [
    'Analyze only this batch of source-code patches.',
    'Return plain text notes, not JSON and not a final commit message.',
    'Use at most eight concise bullet points. Preserve file names and important risks.',
    'Do not claim that tests passed and do not repeat large code excerpts.',
    `Write the notes in ${language}.`,
  ].join('\n');
}

function repairPrompt(language, reviewArchive = false) {
  return [
    reviewArchive
      ? 'Convert the supplied draft into one JSON object with exactly summary, commitMessage, assessment, confidence, and reasons.'
      : 'Convert the supplied draft into one JSON object with exactly summary and commitMessage.',
    'Return JSON only. Do not add analysis, Markdown, or extra keys.',
    `Write summary and commitMessage in ${language}.`,
    'Keep the summary factual and concise. The commit message must be ready for git commit.',
    ...(reviewArchive ? ['Preserve the verdict using assessment suitable, suspicious, or unsuitable, confidence low/medium/high, and 1-5 reasons.'] : []),
  ].join(' ');
}

function requestCompletion({ settings, profile, messages, maxTokens, contextLength, responseSchema = null }, options, onEvent) {
  return createLocalCompletion({
    provider: settings.llmProvider,
    model: profile.requestModel || settings.llmModel,
    loadedModel: Boolean(profile.loadedModel),
    messages,
    responseSchema,
    maxTokens,
    apiToken: options.apiToken ?? options.session?.apiToken ?? settings.llmApiToken,
    contextLength,
    reasoningOffSupported: profile.reasoningOffSupported,
  }, { ...options, onEvent });
}

export function parseResponse(content, { requireAssessment = false } = {}) {
  return parseChangeResponse(content, { requireAssessment });
}

export function extractUnstructured(content) {
  return extractUnstructuredResponse(content);
}

function tryReadable(content, requireAssessment = false) {
  try { return parseChangeResponse(content, { requireAssessment }); } catch { return null; }
}

function resultWithDiagnostics(value, completion, extra) {
  return {
    ...value,
    contextText: buildContextText(value, extra.delivery),
    diagnostics: { finishReason: completion.finishReason, chunks: completion.chunks, usage: completion.usage, ...extra },
    raw: completionDiagnostics(completion, true),
  };
}

function buildContextText(value, delivery) {
  return [
    `Delivery: ${delivery?.resolved ?? 'unknown'}`,
    'Summary:', ...(value.summary ?? []).map((line) => `- ${line}`),
    `Commit message: ${value.commitMessage ?? ''}`,
    ...(value.assessment ? [`Assessment: ${value.assessment} (${value.confidence ?? 'low'})`, ...(value.reasons ?? []).map((line) => `- ${line}`)] : []),
  ].join('\n');
}

function completionDiagnostics(completion, includeOutput = false) {
  return {
    finishReason: completion.finishReason, chunks: completion.chunks, usage: completion.usage,
    contentLength: completion.content?.length ?? 0, reasoningLength: completion.reasoning?.length ?? 0,
    ...(includeOutput ? { content: completion.content ?? '', reasoning: completion.reasoning ?? '' } : {}),
  };
}

function errorDiagnostics(error) {
  return {
    name: error.name, message: error.message, code: error.code ?? null, status: error.status ?? null,
    retryableWithSmallerPrompt: Boolean(error.retryableWithSmallerPrompt), responseBody: error.responseBody ?? null,
  };
}

function attachDiagnostics(error, diagnostics) {
  if (error && typeof error === 'object') error.diagnostics = { ...(error.diagnostics ?? {}), ...diagnostics };
}

function noOutputMessage(completion) {
  if (!completion.content && !completion.reasoning) return 'The local model completed without returning text. Zipflow saved the raw response diagnostics.';
  if (completion.finishReason === 'length') return 'The local model reached its output limit without producing a usable summary or commit message.';
  return 'The local model returned text, but it did not contain a usable summary or commit message.';
}

function changedCount(plan) {
  return (plan.created?.length ?? 0) + (plan.updated?.length ?? 0) + (plan.deleted?.length ?? 0);
}
