import { color, wrapText } from 'terlio.js';
import { activeRunSettings } from './runtime-settings.js';
export function beginLlmProgress(controller, { expectedMs = 0, presentation = 'review' } = {}) {
  const { state } = controller;
  const startedAt = Date.now();
  const settings = activeRunSettings(state);
  state.llmRuntime = {
    provider: settings.llmProvider,
    model: settings.llmModel,
    phase: 'connecting',
    label: 'Connecting to the local LLM server',
    stage: 'generation',
    chunks: 0,
    reasoning: '',
    content: '',
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
      state.llmRuntime = null;
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
    runtime.content = '';
    runtime.reasoning = '';
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
      runtime.reasoning = event.reasoning ?? runtime.reasoning;
      runtime.content = event.content ?? runtime.content;
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

export function llmActivityLines(runtime, width = 100, theme = null) {
  if (!runtime) return [];
  if (runtime.presentation === 'decision') return decisionActivityLines(runtime, width, theme);
  const lines = [
    paint(theme, 'accent', `Local LLM · ${runtime.provider} · ${runtime.model}`),
    runtime.transport ? `  Transport: ${runtime.transport} · POST ${runtime.endpoint}` : null,
    runtime.loadedModel ? `  Model instance: ${runtime.requestModel} · already loaded` : null,
    `  ${paint(theme, 'accent', runtime.label)} · ${formatElapsed(runtime.elapsedMs)}${runtime.expectedMs ? ` / median ${formatElapsed(runtime.expectedMs)}` : ''} · ${runtime.chunks} chunks`,
    runtime.deliveryMode ? `  Delivery: ${deliveryLabel(runtime.deliveryMode)}${runtime.batchTotal ? ` · batch ${runtime.batchIndex}/${runtime.batchTotal}` : ''}` : null,
  ];
  const compact = lines.filter(Boolean);
  lines.length = 0;
  lines.push(...compact);
  if (runtime.coverage) {
    lines.push(
      `  Coverage: ${formatNumber(runtime.coverage.reviewedFiles)} of ${formatNumber(runtime.coverage.totalFiles)} files with content · ${formatNumber(runtime.coverage.manifestFiles)} paths in manifest`,
      `  Patch coverage: ${formatNumber(runtime.coverage.patchCoveragePercent)}% · ${formatNumber(runtime.coverage.omittedFiles)} files omitted`,
    );
  }
  if (runtime.patchBudget?.truncated) {
    lines.push(
      `  Patch: ~${formatNumber(runtime.patchBudget.originalEstimatedTokens)} → ~${formatNumber(runtime.patchBudget.sentEstimatedTokens)} tokens`,
      `  Omitted: ${runtime.patchBudget.omittedFiles} files without excerpts · ${runtime.patchBudget.omittedHunks} hunks`,
    );
  }
  const textWidth = Math.max(28, width - 10);
  const reasoning = preview(runtime.reasoning, 5, textWidth);
  const content = preview(runtime.content, 8, textWidth);
  if (reasoning.length) lines.push(paint(theme, 'textMuted', '  Analysis:'), ...reasoning.map((line) => `    ${paint(theme, 'textMuted', line)}`));
  if (content.length) lines.push(paint(theme, 'accent', '  Model response:'), ...content.map((line) => `    ${line}`));
  lines.push('');
  return lines;
}

function decisionActivityLines(runtime, width, theme) {
  const title = paint(theme, 'accent', `Autopilot decision · ${runtime.provider} · ${runtime.model}`);
  const lines = [
    title,
    `  ${paint(theme, 'accent', runtime.label)} · ${formatElapsed(runtime.elapsedMs)} · ${runtime.chunks} chunks`,
  ];
  const decision = partialDecision(runtime.content || runtime.reasoning);
  if (!decision.hasValues) {
    lines.push(`  ${paint(theme, 'textMuted', 'Receiving a structured decision…')}`);
  } else {
    if (decision.action) lines.push(`  ${paint(theme, 'accent', 'Decision:')} ${actionLabel(decision.action)}`);
    if (decision.confidence !== null) lines.push(`  ${paint(theme, 'accent', 'Confidence:')} ${Math.round(decision.confidence * 100)}%`);
    if (decision.summary) lines.push(...wrappedField('Summary:', decision.summary, width, theme));
    for (const value of decision.evidence) lines.push(...wrappedField('Evidence:', value, width, theme));
    for (const value of decision.risks) lines.push(...wrappedField('Risk:', value, width, theme, 'warning'));
    for (const value of decision.conditions) lines.push(...wrappedField('Condition:', value, width, theme));
  }
  lines.push('');
  return lines;
}

function wrappedField(label, value, width, theme, valueToken = null) {
  const available = Math.max(24, width - 8 - label.length);
  const wrapped = wrapText(String(value ?? ''), available);
  if (!wrapped.length) return [];
  return wrapped.map((line, index) => index === 0
    ? `  ${paint(theme, 'accent', label)} ${valueToken ? paint(theme, valueToken, line) : line}`
    : `  ${' '.repeat(label.length + 1)}${valueToken ? paint(theme, valueToken, line) : line}`);
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
