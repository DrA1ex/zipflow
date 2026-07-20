import { wrapText } from 'terlio.js';
import { activeRunSettings } from './runtime-settings.js';
export function beginLlmProgress(controller, { expectedMs = 0 } = {}) {
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

export function llmActivityLines(runtime, width = 100) {
  if (!runtime) return [];
  const lines = [
    `Local LLM · ${runtime.provider} · ${runtime.model}`,
    runtime.transport ? `  Transport: ${runtime.transport} · POST ${runtime.endpoint}` : null,
    runtime.loadedModel ? `  Model instance: ${runtime.requestModel} · already loaded` : null,
    `  ${runtime.label} · ${formatElapsed(runtime.elapsedMs)}${runtime.expectedMs ? ` / median ${formatElapsed(runtime.expectedMs)}` : ''} · ${runtime.chunks} chunks`,
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
  if (reasoning.length) lines.push('  Analysis:', ...reasoning.map((line) => `    ${line}`));
  if (content.length) lines.push('  Model response:', ...content.map((line) => `    ${line}`));
  lines.push('');
  return lines;
}

function preview(value, maxLines, width) {
  const source = String(value ?? '').replace(/\r\n/g, '\n').trimEnd();
  if (!source) return [];
  const wrapped = source.split('\n').flatMap((line) => wrapText(line, width));
  return wrapped.slice(-maxLines);
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
