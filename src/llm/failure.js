import { createLocalCompletion } from './client.js';
import { getLocalModelProfile } from './model-info.js';

const MAX_FAILURE_OUTPUT_CHARS = 24_000;

export async function explainCheckFailure({ settings, project, run, failedCheck }, options = {}) {
  if (!failedCheck || settings.llmFailureAnalysis === 'disabled') return null;
  const notify = options.onEvent ?? (() => {});
  notify({ type: 'phase', phase: 'failure-model-info', label: 'Preparing local LLM error explanation' });
  const profile = await getLocalModelProfile(settings.llmProvider, settings.llmModel, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.metadataTimeoutMs ?? 10_000,
    apiToken: settings.llmApiToken,
    signal: options.signal,
  });
  notify({ type: 'model-profile', profile });
  const sameContext = settings.llmFailureAnalysis === 'same-context' && run.llm?.contextText;
  const messages = [
    { role: 'system', content: failureSystemPrompt(settings.llmLanguage || 'English') },
    ...(sameContext ? [{ role: 'assistant', content: run.llm.contextText }] : []),
    { role: 'user', content: failureUserPrompt(project, run, failedCheck, sameContext) },
  ];
  const completion = await createLocalCompletion({
    provider: settings.llmProvider,
    model: profile.requestModel || settings.llmModel,
    loadedModel: Boolean(profile.loadedModel),
    messages,
    responseSchema: null,
    maxTokens: 1_024,
    apiToken: settings.llmApiToken,
    contextLength: Math.min(profile.contextLength || 16_384, 16_384),
    reasoningOffSupported: profile.reasoningOffSupported,
  }, {
    ...options,
    onEvent: (event) => notify({ ...event, stage: 'failure-analysis' }),
  });
  const text = String(completion.content || completion.reasoning || '').trim();
  if (!text) throw new Error('The local model did not return an error explanation.');
  return {
    text,
    mode: sameContext ? 'same-context' : 'new-context',
    provider: settings.llmProvider,
    model: settings.llmModel,
    finishReason: completion.finishReason,
    chunks: completion.chunks,
  };
}

function failureSystemPrompt(language) {
  return [
    'You explain failed developer checks after a source-code update.',
    'Return readable plain text, not JSON and not Markdown fences.',
    'Use exactly these headings: ERROR EXPLANATION:, LIKELY CAUSE:, NEXT STEPS:.',
    'Under NEXT STEPS use one to five short bullet points.',
    'Distinguish evidence from guesses. Do not claim a fix is certain when the output is ambiguous.',
    'Do not repeat the entire command output.',
    `Write the explanation in ${language}.`,
  ].join('\n');
}

function failureUserPrompt(project, run, failedCheck, sameContext) {
  const output = [failedCheck.stdout, failedCheck.stderr].filter(Boolean).join('\n').trim();
  return [
    `Project: ${project.name}`,
    `Failed check: ${failedCheck.name}`,
    `Command: ${failedCheck.commandText ?? failedCheck.command ?? '(unknown)'}`,
    `Exit code: ${failedCheck.code ?? 'unknown'}`,
    `Change summary available in previous context: ${sameContext ? 'yes' : 'no'}`,
    '', 'FAILED OUTPUT START', output.slice(-MAX_FAILURE_OUTPUT_CHARS) || '(no output)', 'FAILED OUTPUT END',
  ].join('\n');
}
