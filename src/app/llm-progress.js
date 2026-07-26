import { color, wrapText } from 'terlio.js';
import { activeRunSettings } from './runtime-settings.js';
import { insertMessage } from './state.js';
import { inferLanguage, standaloneCode } from '../ui/rich-text.js';
import { BoundedByteBuffer } from '../utils/byte-buffer.js';
import { translateForState as t } from '../i18n/index.js';
export function beginLlmProgress(controller, { expectedMs = 0, presentation = 'review', preserveRaw = null } = {}) {
  const { state } = controller;
  const startedAt = Date.now();
  const settings = activeRunSettings(state);
  const keepRaw = preserveRaw ?? Boolean(settings?.llmVerboseOutput);
  const rawMessageIndex = state.messages.length;
  state.llmRuntime = {
    provider: settings.llmProvider,
    model: settings.llmModel,
    phase: 'connecting',
    label: 'Connecting to the local LLM server',
    stage: 'generation',
    chunks: 0,
    reasoning: '',
    content: '',
    reasoningBuffer: new BoundedByteBuffer(2 * 1024 * 1024),
    contentBuffer: new BoundedByteBuffer(2 * 1024 * 1024),
    elapsedMs: 0,
    promptProgress: null,
    modelLoadProgress: null,
    patchBudget: null,
    transport: null,
    endpoint: null,
    requestModel: null,
    loadedModel: false,
    cancellationRequested: false,
    expectedMs,
    deliveryMode: null,
    batchIndex: null,
    batchTotal: null,
    presentation,
  };
  const timer = setInterval(() => {
    if (!state.llmRuntime) return;
    state.llmRuntime.elapsedMs = Date.now() - startedAt;
    controller.invalidate();
  }, 500);
  timer.unref?.();
  controller.invalidate();
  return {
    onEvent: (event) => updateLlmProgress(controller, event),
    stop: () => {
      clearInterval(timer);
      const finished = state.llmRuntime;
      state.llmRuntime = null;
      const finishedReasoning = streamText(finished, 'reasoning');
      const finishedContent = streamText(finished, 'content');
      if (keepRaw && finished && (finishedReasoning.trim() || finishedContent.trim())) {
        const lines = [];
        if (finishedReasoning.trim()) lines.push('Analysis', ...finishedReasoning.replace(/\r\n/g, '\n').split('\n'));
        if (finishedContent.trim()) {
          if (lines.length) lines.push('');
          const rawContent = finishedContent.replace(/\r\n?/g, '\n');
          const code = standaloneCode(rawContent);
          lines.push('Model response', ...(code
            ? [`\`\`\`${code.language}`, ...code.code.split('\n'), '```']
            : rawContent.split('\n')));
        }
        insertMessage(state, rawMessageIndex, 'Raw LLM response', lines, 'info', {
          collapsible: true,
          collapsed: true,
          collapsedSummary: `Raw LLM response · ${finished.chunks || 0} chunks`,
        });
      }
      controller.invalidate();
    },
  };
}

export function updateLlmProgress(controller, event) {
  const runtime = controller.state.llmRuntime;
  if (!runtime) return;
  runtime.stage = event.stage ?? runtime.stage;
  if (event.type === 'phase') {
    runtime.phase = event.phase;
    runtime.label = event.label;
  } else if (event.type === 'delivery-mode') {
    runtime.deliveryMode = event.deliveryMode;
    runtime.label = `Change delivery: ${deliveryLabel(event.deliveryMode)}`;
  } else if (event.type === 'coverage') {
    runtime.coverage = event;
    runtime.label = `Reviewed content from ${formatNumber(event.reviewedFiles)} of ${formatNumber(event.totalFiles)} changed files`;
  } else if (event.type === 'change-list') {
    runtime.deliveryMode = 'change-list';
    runtime.label = `Sending ${formatNumber(event.paths)} changed paths without file contents`;
  } else if (event.type === 'batch-start') {
    runtime.phase = 'chunk-analysis';
    runtime.deliveryMode = runtime.deliveryMode === 'capped' ? 'capped' : 'chunked';
    runtime.batchIndex = event.index;
    runtime.batchTotal = event.total;
    resetStreamBuffer(runtime, 'content');
    resetStreamBuffer(runtime, 'reasoning');
    runtime.label = `Analyzing file batch ${event.index} of ${event.total}`;
  } else if (event.type === 'batch-complete') {
    runtime.label = `File batch ${event.index} of ${event.total} analyzed`;
  } else if (event.type === 'patch-budget') {
    runtime.patchBudget = event.patch;
    runtime.contextProfile = event.profile;
    runtime.label = event.patch.truncated
      ? `Patch reduced to about ${formatNumber(event.patch.sentEstimatedTokens)} tokens`
      : `Patch fits the model context at about ${formatNumber(event.patch.sentEstimatedTokens)} tokens`;
  } else if (event.type === 'tree-budget') {
    runtime.treeBudget = event;
    runtime.label = event.truncated
      ? `Project/archive tree reduced to ${formatNumber(event.sentEntries)} entries`
      : `Project/archive tree includes ${formatNumber(event.sentEntries)} entries`;
  } else if (event.type === 'model-profile') {
    runtime.contextProfile = event.profile;
    runtime.requestModel = event.profile?.requestModel ?? runtime.model;
    runtime.loadedModel = Boolean(event.profile?.loadedModel);
    runtime.label = runtime.loadedModel
      ? 'Using the already loaded model instance'
      : 'The selected model will be loaded by the provider if needed';
  } else if (event.type === 'request') {
    runtime.phase = 'waiting';
    runtime.transport = event.transport ?? runtime.transport;
    runtime.endpoint = event.endpoint ?? runtime.endpoint;
    runtime.requestModel = event.model ?? runtime.requestModel;
    runtime.loadedModel = Boolean(event.loadedModel ?? runtime.loadedModel);
    runtime.promptProgress = null;
    runtime.label = event.attempt > 1
      ? 'Retrying with a simpler JSON response format'
      : 'Waiting for the model to process the patch';
  } else if (event.type === 'retry') {
    runtime.phase = 'retrying';
    runtime.label = `Structured output was rejected · ${event.reason}`;
  } else if (event.type === 'smaller-retry') {
    runtime.phase = 'retrying';
    runtime.promptProgress = null;
    runtime.label = event.reason === 'out_of_memory'
      ? 'Model memory was exhausted · retrying with a smaller patch'
      : 'Patch exceeded the model context · retrying with a smaller patch';
  } else if (event.type === 'stream-open') {
    runtime.phase = 'waiting';
    runtime.label = 'Stream connected · waiting for prompt processing';
  } else if (event.type === 'model-load-start') {
    runtime.phase = 'loading-model';
    runtime.modelLoadProgress = 0;
    runtime.label = 'Loading the selected model';
  } else if (event.type === 'model-load-progress') {
    runtime.phase = 'loading-model';
    runtime.modelLoadProgress = event.progress;
    runtime.label = `Loading the selected model · ${formatPercent(event.progress)}`;
  } else if (event.type === 'model-load-end') {
    runtime.modelLoadProgress = 1;
    runtime.label = 'Model loaded · preparing the prompt';
  } else if (event.type === 'prompt-progress') {
    runtime.phase = 'prompt';
    runtime.promptProgress = event.progress;
    runtime.label = `Processing the patch · ${formatPercent(event.progress)}`;
  } else if (event.type === 'chunk') {
    runtime.chunks = event.chunks ?? runtime.chunks;
    if (!event.hiddenOutput) {
      appendStreamEvent(runtime, 'reasoning', event.reasoningDelta, event.reasoning);
      appendStreamEvent(runtime, 'content', event.contentDelta, event.content);
    }
    if (event.contentDelta) {
      runtime.phase = 'answer';
      runtime.label = runtime.stage === 'repair' ? 'Formatting the response internally' : 'Receiving the model response';
    } else if (event.reasoningDelta) {
      runtime.phase = 'reasoning';
      runtime.label = 'The model is analyzing the patch';
    }
  } else if (event.type === 'cancel-requested') {
    runtime.phase = 'cancelling';
    runtime.cancellationRequested = true;
    runtime.label = 'Cancelling local LLM generation';
  } else if (event.type === 'complete') {
    runtime.phase = 'parsing';
    runtime.label = event.finishReason === 'length'
      ? 'Output limit reached · checking the generated draft'
      : 'Parsing the model response';
  }
  controller.invalidate();
}


function appendStreamEvent(runtime, key, delta, complete) {
  const bufferKey = `${key}Buffer`;
  if (!runtime[bufferKey]) runtime[bufferKey] = new BoundedByteBuffer(2 * 1024 * 1024);
  if (delta) {
    if (runtime[bufferKey].byteLength === 0 && complete != null && String(complete) !== String(delta)) runtime[bufferKey].append(complete);
    else runtime[bufferKey].append(delta);
  } else if (complete != null) {
    runtime[bufferKey] = new BoundedByteBuffer(2 * 1024 * 1024);
    runtime[bufferKey].append(complete);
  }
}

function resetStreamBuffer(runtime, key) {
  runtime[`${key}Buffer`] = new BoundedByteBuffer(2 * 1024 * 1024);
  runtime[key] = '';
}

function streamText(runtime, key) {
  return runtime?.[`${key}Buffer`]?.toString() ?? String(runtime?.[key] ?? '');
}

export function llmActivityLines(runtime, width = 100, theme = null, { renderCode = null, state = null } = {}) {
  if (!runtime) return [];
  if (runtime.presentation === 'decision') return decisionActivityLines(runtime, width, theme, state);
  const lines = [
    paint(theme, 'accent', `${t(state, 'Local LLM')} · ${runtime.provider} · ${runtime.model}`),
    runtime.transport ? `  ${t(state, 'Transport:')} ${runtime.transport} · POST ${runtime.endpoint}` : null,
    runtime.loadedModel ? `  ${t(state, 'Model instance:')} ${runtime.requestModel} · ${t(state, 'already loaded')}` : null,
    `  ${paint(theme, 'accent', llmProgressLabel(state, runtime))} · ${formatElapsed(runtime.elapsedMs)}${runtime.expectedMs ? ` / ${t(state, 'median')} ${formatElapsed(runtime.expectedMs)}` : ''} · ${runtime.chunks} ${t(state, 'chunks')}`,
    runtime.deliveryMode ? `  ${t(state, 'Delivery:')} ${t(state, deliveryLabel(runtime.deliveryMode))}${runtime.batchTotal ? ` · ${t(state, 'batch')} ${runtime.batchIndex}/${runtime.batchTotal}` : ''}` : null,
  ];
  const compact = lines.filter(Boolean);
  lines.length = 0;
  lines.push(...compact);
  if (runtime.coverage) {
    lines.push(
      `  ${t(state, 'Coverage:')} ${formatNumber(runtime.coverage.reviewedFiles)} ${t(state, 'of')} ${formatNumber(runtime.coverage.totalFiles)} ${t(state, 'files with content')} · ${formatNumber(runtime.coverage.manifestFiles)} ${t(state, 'paths in manifest')}`,
      `  ${t(state, 'Patch coverage:')} ${formatNumber(runtime.coverage.patchCoveragePercent)}% · ${formatNumber(runtime.coverage.omittedFiles)} ${t(state, 'files omitted')}`,
    );
  }
  if (runtime.patchBudget?.truncated) {
    lines.push(
      `  ${t(state, 'Patch:')} ~${formatNumber(runtime.patchBudget.originalEstimatedTokens)} → ~${formatNumber(runtime.patchBudget.sentEstimatedTokens)} ${t(state, 'tokens')}`,
      `  ${t(state, 'Omitted:')} ${runtime.patchBudget.omittedFiles} ${t(state, 'files without excerpts')} · ${runtime.patchBudget.omittedHunks} ${t(state, 'hunks')}`,
    );
  }
  const textWidth = Math.max(28, width - 10);
  const reasoning = preview(streamText(runtime, 'reasoning'), 5, textWidth);
  const contentText = streamText(runtime, 'content').replace(/\r\n?/g, '\n');
  const contentLanguage = inferLanguage(contentText);
  const highlightedContent = renderCode && contentLanguage !== 'text'
    ? renderCode(previewSource(contentText, 8), contentLanguage, { width: textWidth + 4, indent: 4 })
    : null;
  const content = highlightedContent ?? preview(contentText, 8, textWidth).map((line) => `    ${line}`);
  if (reasoning.length) lines.push(paint(theme, 'textMuted', `  ${t(state, 'Analysis:')}`), ...reasoning.map((line) => `    ${paint(theme, 'textMuted', line)}`));
  if (content.length) lines.push(paint(theme, 'accent', `  ${t(state, 'Model response:')}`), ...content);
  lines.push('');
  return lines;
}

function decisionActivityLines(runtime, width, theme, state) {
  const title = paint(theme, 'accent', `${t(state, 'Autopilot decision')} · ${runtime.provider} · ${runtime.model}`);
  const lines = [
    title,
    `  ${paint(theme, 'accent', llmProgressLabel(state, runtime))} · ${formatElapsed(runtime.elapsedMs)} · ${runtime.chunks} ${t(state, 'chunks')}`,
  ];
  const decision = partialDecision(streamText(runtime, 'content') || streamText(runtime, 'reasoning'));
  if (!decision.hasValues) {
    lines.push(`  ${paint(theme, 'textMuted', t(state, 'Receiving a structured decision…'))}`);
  } else {
    if (decision.action) lines.push(`  ${paint(theme, 'accent', t(state, 'Decision:'))} ${t(state, actionLabel(decision.action))}`);
    if (decision.confidence !== null) lines.push(`  ${paint(theme, 'accent', t(state, 'Confidence:'))} ${t(state, confidenceLabel(decision.confidence))}`);
    if (decision.summary) lines.push(...wrappedField(t(state, 'Summary:'), decision.summary, width, theme));
    if (decision.evidence.length) lines.push(`  ${paint(theme, 'accent', t(state, 'Evidence:'))}`, ...decision.evidence.flatMap((value) => wrappedBullet(value, width, theme)));
    if (decision.risks.length) lines.push(`  ${paint(theme, 'accent', t(state, 'Risks:'))}`, ...decision.risks.filter((value) => !isNoneValue(value)).flatMap((value) => wrappedBullet(value, width, theme, 'warning')));
    if (decision.conditions.length) lines.push(`  ${paint(theme, 'accent', t(state, 'Conditions:'))}`, ...decision.conditions.filter((value) => !isNoneValue(value)).flatMap((value) => wrappedBullet(value, width, theme)));
  }
  lines.push('');
  return lines;
}

export function llmProgressLabel(state, runtime) {
  if (!runtime) return '';
  if (runtime.deliveryMode && String(runtime.label ?? '').startsWith('Change delivery:')) {
    return `${t(state, 'Change delivery:')} ${t(state, deliveryLabel(runtime.deliveryMode))}`;
  }
  return t(state, runtime.label ?? '');
}

function wrappedField(label, value, width, theme, valueToken = null) {
  const available = Math.max(24, width - 8 - label.length);
  const wrapped = wrapText(String(value ?? ''), available);
  if (!wrapped.length) return [];
  return wrapped.map((line, index) => index === 0
    ? `  ${paint(theme, 'accent', label)} ${valueToken ? paint(theme, valueToken, line) : line}`
    : `  ${' '.repeat(label.length + 1)}${valueToken ? paint(theme, valueToken, line) : line}`);
}

function wrappedBullet(value, width, theme, valueToken = null) {
  const wrapped = wrapText(String(value ?? ''), Math.max(24, width - 12));
  return wrapped.map((line, index) => `    ${index === 0 ? '• ' : '  '}${valueToken ? paint(theme, valueToken, line) : line}`);
}

function confidenceLabel(value) {
  const number = Number(value);
  if (number >= 0.8) return 'High';
  if (number >= 0.55) return 'Medium';
  return 'Low';
}

function isNoneValue(value) {
  return /^(?:none|none identified|no (?:material )?(?:risk|risks|condition|conditions)(?: identified)?)[.!]?$/i.test(String(value ?? '').trim());
}

function partialDecision(value) {
  const text = String(value ?? '').trim();
  const complete = parseJsonObject(text);
  const source = complete ?? {};
  const action = stringField(text, 'action') ?? stringValue(source.action);
  const summary = stringField(text, 'summary') ?? stringValue(source.summary);
  const confidence = numberField(text, 'confidence') ?? finiteConfidence(source.confidence);
  const evidence = arrayField(text, 'evidence', source.evidence);
  const risks = arrayField(text, 'risks', source.risks);
  const conditions = arrayField(text, 'conditions', source.conditions);
  return {
    action, summary, confidence, evidence, risks, conditions,
    hasValues: Boolean(action || summary || confidence !== null || evidence.length || risks.length || conditions.length),
  };
}

function parseJsonObject(text) {
  const candidates = [text];
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

function stringField(text, key) {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return null;
  try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
}

function numberField(text, key) {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? finiteConfidence(match[1]) : null;
}

function arrayField(text, key, fallback) {
  if (Array.isArray(fallback)) return fallback.map(stringValue).filter(Boolean).slice(0, 8);
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)(?:\\]|$)`));
  if (!match) return [];
  const values = [];
  const pattern = /"((?:\\.|[^"\\])*)"/g;
  let item;
  while ((item = pattern.exec(match[1])) && values.length < 8) {
    try { values.push(JSON.parse(`"${item[1]}"`)); } catch { values.push(item[1]); }
  }
  return values.filter(Boolean);
}

function finiteConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function actionLabel(value) {
  return String(value ?? '').split('-').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '').join(' ');
}

function previewSource(value, maxLines) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').trimEnd().split('\n');
  return lines.slice(-maxLines).join('\n');
}

function preview(value, maxLines, width) {
  const source = String(value ?? '').replace(/\r\n/g, '\n').trimEnd();
  if (!source) return [];
  const wrapped = source.split('\n').flatMap((line) => wrapText(line, width));
  return wrapped.slice(-maxLines);
}

function paint(theme, token, value) {
  return theme ? color(theme, token, value) : String(value ?? '');
}

function deliveryLabel(value) {
  if (value === 'patch') return 'full patch';
  if (value === 'representative') return 'representative sample';
  if (value === 'capped') return 'capped batches';
  if (value === 'change-list') return 'changed paths only';
  if (value === 'chunked') return 'file-by-file chunks';
  return value || 'adaptive';
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor((milliseconds ?? 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return '0%';
  return `${Math.round(Number(value) * 100)}%`;
}

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString('en-US');
}
