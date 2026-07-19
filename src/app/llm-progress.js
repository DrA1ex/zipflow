export function beginLlmProgress(controller) {
  const { state } = controller;
  const startedAt = Date.now();
  state.llmRuntime = {
    provider: state.settings.llmProvider,
    model: state.settings.llmModel,
    phase: 'connecting',
    label: 'Connecting to the local LLM server',
    stage: 'generation',
    chunks: 0,
    reasoning: '',
    content: '',
    elapsedMs: 0,
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
  } else if (event.type === 'request') {
    runtime.phase = 'waiting';
    runtime.label = event.attempt > 1
      ? 'Retrying with a simpler JSON response format'
      : 'Waiting for the model to process the patch';
  } else if (event.type === 'retry') {
    runtime.phase = 'retrying';
    runtime.label = `Structured output was rejected · ${event.reason}`;
  } else if (event.type === 'stream-open') {
    runtime.phase = 'waiting';
    runtime.label = 'Stream connected · waiting for the first model token';
  } else if (event.type === 'chunk') {
    runtime.chunks = event.chunks ?? runtime.chunks;
    runtime.reasoning = event.reasoning ?? runtime.reasoning;
    runtime.content = event.content ?? runtime.content;
    if (event.contentDelta) {
      runtime.phase = 'answer';
      runtime.label = runtime.stage === 'repair' ? 'Receiving the formatted answer' : 'Receiving the model answer';
    } else if (event.reasoningDelta) {
      runtime.phase = 'reasoning';
      runtime.label = 'The model is analyzing the patch';
    }
  } else if (event.type === 'complete') {
    runtime.phase = 'parsing';
    runtime.label = event.finishReason === 'length'
      ? 'Output limit reached · checking the generated draft'
      : 'Parsing the model response';
  }
  controller.invalidate();
}

export function llmActivityLines(runtime) {
  if (!runtime) return [];
  const lines = [
    `Local LLM · ${runtime.provider} · ${runtime.model}`,
    `  ${runtime.label} · ${formatElapsed(runtime.elapsedMs)} · ${runtime.chunks} chunks`,
  ];
  const reasoning = preview(runtime.reasoning, 5);
  const content = preview(runtime.content, 5);
  if (reasoning.length) lines.push('  Model draft:', ...reasoning.map((line) => `    ${line}`));
  if (content.length) lines.push('  Structured answer:', ...content.map((line) => `    ${line}`));
  lines.push('');
  return lines;
}

function preview(value, maxLines) {
  const source = String(value ?? '').trim();
  if (!source) return [];
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const selected = lines.slice(-maxLines).map((line) => line.length > 160 ? `${line.slice(0, 157)}…` : line);
  return selected;
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor((milliseconds ?? 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
