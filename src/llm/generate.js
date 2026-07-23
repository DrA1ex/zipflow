import { createLocalCompletion } from './client.js';
import { resolveLocalLlmSession } from './session.js';
import { createPromptBudget, fitPatchToBudget, reducePatchBudget } from './patch-budget.js';
import {
  createCappedPatchBatches, createChangeList, createPatchBatches, createRepresentativePatch,
  estimateTokens, resolveDeliveryMode,
} from './delivery.js';
import {
  extractUnstructuredResponse, parseChangeResponse, readableResponseInstructions,
} from './response.js';
import { commitLanguage, promptLanguage, promptLanguageDirective, summaryLanguage } from './language.js';
import { llmTasks } from './tasks.js';

function responseSchema(tasks) {
  const properties = {};
  const required = [];
  if (tasks.summary) {
    properties.summary = { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } };
    required.push('summary');
  }
  if (tasks.commitMessage) {
    properties.commitMessage = { type: 'string', minLength: 1 };
    required.push('commitMessage');
  }
  if (tasks.archiveReview) {
    properties.assessment = { type: 'string', enum: ['suitable', 'suspicious', 'unsuitable'] };
    properties.confidence = { type: 'string', enum: ['low', 'medium', 'high'] };
    properties.reasons = { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } };
    required.push('assessment', 'confidence', 'reasons');
  }
  return { type: 'object', additionalProperties: false, properties, required };
}

const MAX_REPAIR_DRAFT_CHARS = 40_000;
const GENERATION_ATTEMPTS = 3;

export function isLocalLlmEnabled(settings) {
  return ['ollama', 'lmstudio'].includes(settings?.llmProvider) && Boolean(settings?.llmModel);
}

export async function generateChangeDescription({ settings, project, plan, patchContent }, options = {}) {
  if (!isLocalLlmEnabled(settings)) return null;
  const notify = options.onEvent ?? (() => {});
  const languages = {
    prompt: promptLanguage(settings), summary: summaryLanguage(settings), commit: commitLanguage(settings),
  };
  const selectedTasks = llmTasks(settings);
  const tasks = {
    archiveReview: selectedTasks.archiveReview && settings.llmArchiveReview === 'patch',
    summary: selectedTasks.summary,
    commitMessage: selectedTasks.commitMessage,
  };
  if (!tasks.archiveReview && !tasks.summary && !tasks.commitMessage) return null;
  const outputSchema = responseSchema(tasks);
  const system = buildSystemPrompt(languages, tasks);
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
    fileCount: changedCount(plan),
  });
  notify({ type: 'delivery-mode', requestedMode, deliveryMode });
  const context = { settings, project, plan, patchContent, profile, budget, system, tasks, deliveryMode };
  const generation = deliveryMode === 'chunked'
    ? await generateChunked(context, options, notify)
    : deliveryMode === 'capped'
      ? await generateChunked(context, options, notify, { capped: true })
      : deliveryMode === 'representative'
        ? await generateRepresentative(context, options, notify)
        : deliveryMode === 'change-list'
          ? await generateFromChangeList(context, options, notify)
          : await generateFromPatch(context, options, notify);

  const completion = generation.completion;
  const direct = tryReadable(completion.content, tasks) ?? tryReadable(completion.reasoning, tasks);
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
        responseSchema: outputSchema,
        messages: [
          { role: 'system', content: repairPrompt(languages, tasks) },
          { role: 'user', content: `DRAFT START\n${draft}\nDRAFT END` },
        ],
      }, options, (event) => notify({ ...event, stage: 'repair', hiddenOutput: true }));
      const parsed = tryReadable(repaired.content, tasks) ?? tryReadable(repaired.reasoning, tasks);
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

  const partial = extractUnstructuredResponse(completion.content || completion.reasoning, taskRequirements(tasks));
  if (hasRequestedOutput(partial, tasks)) return {
    ...partial,
    warning: 'The local model returned an unexpected text format; Zipflow extracted the requested visible output.',
    diagnostics: {
      profile, budget, delivery: generation.delivery, attempts: generation.attempts,
      finishReason: completion.finishReason, chunks: completion.chunks, repaired: false, partial: true,
    },
    raw: completionDiagnostics(completion, true),
  };

  const error = new Error(noOutputMessage(completion, tasks));
  error.code = 'no_usable_output';
  error.diagnostics = {
    profile, budget, delivery: generation.delivery, attempts: generation.attempts,
    completion: completionDiagnostics(completion, true),
  };
  throw error;
}


async function generateFromPatch(context, options, notify, { deliveryMode = 'patch', coverage = null, payloadKind = 'patch' } = {}) {
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
          { role: 'user', content: buildUserPrompt(context.project, context.plan, { kind: payloadKind, content: fitted.content, coverage }) },
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
  return { completion, attempts, delivery: { requested: context.settings.llmChangeDelivery, resolved: deliveryMode, ...(coverage ? { coverage } : {}) } };
}

async function generateRepresentative(context, options, notify) {
  const sample = createRepresentativePatch(context.patchContent, {
    maxFiles: Number(context.settings.llmRepresentativeMaxFiles) || 8,
  });
  notify({ type: 'coverage', ...sample.coverage });
  return generateFromPatch(
    { ...context, patchContent: sample.content },
    options,
    notify,
    { deliveryMode: 'representative', coverage: sample.coverage, payloadKind: 'sample' },
  );
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

async function generateChunked(context, options, notify, { capped = false } = {}) {
  const maxBatchTokens = Math.max(1_500, Math.min(5_000, Math.floor(context.budget.patchTokens * 0.45)));
  const cappedResult = capped ? createCappedPatchBatches(context.patchContent, {
    maxEstimatedTokens: maxBatchTokens, maxBatches: 3, maxFiles: 12, maxFilesPerBatch: 4,
  }) : null;
  const batches = cappedResult?.batches ?? createPatchBatches(context.patchContent, { maxEstimatedTokens: maxBatchTokens });
  const coverage = cappedResult?.coverage ?? null;
  if (coverage) notify({ type: 'coverage', ...coverage });
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
      requested: context.settings.llmChangeDelivery, resolved: capped ? 'capped' : 'chunked',
      batches: batches.length, files: [...new Set(batches.flatMap((batch) => batch.files))].length,
      ...(coverage ? { coverage } : {}),
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
          { role: 'system', content: chunkPrompt({
            prompt: promptLanguage(context.settings), summary: summaryLanguage(context.settings),
          }) },
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

function buildSystemPrompt(languages, tasks) {
  return [
    promptLanguageDirective(languages.prompt),
    'You analyze source-code patches and other source-code change representations for a developer workflow tool.',
    'Be factual and concise. Mention behavior, architecture, tests, or risks only when supported by the supplied information.',
    'Do not invent test results, issue numbers, or motivations.',
    ...(tasks.archiveReview ? [
      'Assess whether the archive changes plausibly belong to this project and return assessment suitable, suspicious, or unsuitable.',
      'Use unsuitable only for strong evidence of a wrong archive. Use suspicious for ambiguous, destructive, or unexpectedly broad changes.',
      'This assessment is advisory and never replaces deterministic safety checks.',
    ] : []),
    readableResponseInstructions(
      { summary: languages.summary, commit: languages.commit },
      { assessment: tasks.archiveReview, requireSummary: tasks.summary, requireCommitMessage: tasks.commitMessage },
    ),
  ].join('\n\n');
}

function buildUserPrompt(project, plan, payload) {
  const intro = [
    `Project: ${project.name}`,
    `Project types: ${(project.workspaceLabels ?? project.labels ?? []).join(', ') || 'unknown'}`,
    `Plan counts: created=${plan.counts.created}, updated=${plan.counts.updated}, deleted=${plan.counts.deleted}`,
  ];
  if (payload.kind === 'patch' || payload.kind === 'sample') return [
    ...intro, '', 'CHANGED PATHS:', createChangeList(plan),
    ...(payload.kind === 'sample' ? ['', `REPRESENTATIVE PATCH SAMPLE: ${payload.coverage?.reviewedFiles ?? 0} of ${payload.coverage?.totalFiles ?? 0} changed files include content.`, 'Do not imply that omitted file contents were reviewed.'] : []),
    '', 'PATCH START', payload.content, 'PATCH END',
  ].join('\n');
  return [...intro, '', 'CHANGED PATHS:', payload.content, '', 'No file contents are provided. Base the response only on path-level evidence and clearly avoid content-specific claims.'].join('\n');
}

function buildSynthesisPrompt(project, plan, notes) {
  return [
    `Project: ${project.name}`,
    `Project types: ${(project.workspaceLabels ?? project.labels ?? []).join(', ') || 'unknown'}`,
    `Plan counts: created=${plan.counts.created}, updated=${plan.counts.updated}, deleted=${plan.counts.deleted}`,
    '', 'COMPLETE CHANGED PATH LIST:', createChangeList(plan),
    '', 'FILE-BATCH ANALYSIS NOTES:', notes.join('\n\n---\n\n'),
    '', 'Create the final response now. Reconcile duplicated notes, do not claim that tests passed, and do not imply that unreviewed file contents were analyzed.',
  ].join('\n');
}

function chunkPrompt(languages) {
  return [
    promptLanguageDirective(languages.prompt),
    'Analyze only this batch of source-code patches.',
    'Return plain text notes, not JSON and not a final commit message.',
    'Use at most eight concise bullet points. Preserve file names and important risks.',
    'Do not claim that tests passed and do not repeat large code excerpts.',
    `Write the notes in ${languages.summary}.`,
  ].join('\n');
}

function repairPrompt(languages, tasks) {
  const fields = [
    tasks.summary ? 'summary' : null,
    tasks.commitMessage ? 'commitMessage' : null,
    ...(tasks.archiveReview ? ['assessment', 'confidence', 'reasons'] : []),
  ].filter(Boolean);
  return [
    promptLanguageDirective(languages.prompt),
    `Convert the supplied draft into one JSON object with exactly ${fields.join(', ')}.`,
    'Return JSON only. Do not add analysis, Markdown, or extra keys.',
    ...(tasks.summary && tasks.archiveReview ? [`Write summary and reasons in ${languages.summary}.`]
      : tasks.summary ? [`Write summary in ${languages.summary}.`]
        : tasks.archiveReview ? [`Write reasons in ${languages.summary}.`] : []),
    ...(tasks.commitMessage ? [`Write commitMessage in ${languages.commit}. The commit message must be ready for git commit.`] : []),
    ...(tasks.summary ? ['Keep the summary factual and concise.'] : []),
    ...(tasks.archiveReview ? ['Preserve the verdict using assessment suitable, suspicious, or unsuitable, confidence low/medium/high, and 1-5 reasons.'] : []),
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

export function parseResponse(content, options = {}) {
  return parseChangeResponse(content, options);
}

export function extractUnstructured(content) {
  return extractUnstructuredResponse(content);
}

function tryReadable(content, tasks) {
  try { return parseChangeResponse(content, taskRequirements(tasks)); } catch { return null; }
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
    ...(value.summary?.length ? ['Summary:', ...value.summary.map((line) => `- ${line}`)] : []),
    ...(value.commitMessage ? [`Commit message: ${value.commitMessage}`] : []),
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

function noOutputMessage(completion, tasks) {
  const requested = requestedOutputLabel(tasks);
  if (!completion.content && !completion.reasoning) return 'The local model completed without returning text. Zipflow saved the raw response diagnostics.';
  if (completion.finishReason === 'length') return `The local model reached its output limit without producing usable ${requested}.`;
  return `The local model returned text, but it did not contain usable ${requested}.`;
}

function taskRequirements(tasks) {
  return {
    requireAssessment: tasks.archiveReview,
    requireSummary: tasks.summary,
    requireCommitMessage: tasks.commitMessage,
  };
}

function hasRequestedOutput(value, tasks) {
  if (tasks.summary && !value.summary?.length) return false;
  if (tasks.commitMessage && !value.commitMessage) return false;
  return tasks.summary || tasks.commitMessage;
}

function requestedOutputLabel(tasks) {
  const values = [tasks.archiveReview ? 'archive assessment' : null, tasks.summary ? 'summary' : null, tasks.commitMessage ? 'commit message' : null].filter(Boolean);
  return values.length === 1 ? values[0] : values.join(', ');
}

function changedCount(plan) {
  return (plan.created?.length ?? 0) + (plan.updated?.length ?? 0) + (plan.deleted?.length ?? 0);
}
