import { copyTextToClipboard } from 'terlio.js';
import { loadStoredPatch } from '../diff/stored-patch.js';
import { generateChangeDescription } from '../llm/generate.js';
import { listProjectRuns } from '../runs/store.js';
import { exists } from '../utils/fs.js';

export async function loadModelReplayRuns(controller) {
  const { state } = controller;
  if (!state.project) return [];
  const runs = await listProjectRuns(state.project.root, { limit: 60 });
  const result = [];
  for (const run of runs.filter((item) => !item.kind && item.plan?.counts)) {
    const available = Boolean(run.patch?.path) && await exists(run.patch.path);
    result.push({ ...run, replayAvailable: available });
  }
  state.settingsPanel.replayRuns = result;
  return result;
}

export async function startHistoricalModelReplay(controller, runId) {
  const { state } = controller;
  const run = state.settingsPanel?.replayRuns?.find((item) => item.id === runId);
  if (!run || !run.replayAvailable) {
    controller.toast('The stored patch for this run is unavailable', 'warning');
    return false;
  }
  const patch = await loadStoredPatch(run);
  if (!patch) return false;
  const abortController = new AbortController();
  const workspace = {
    runId, archivePath: run.archivePath, running: true, status: 'Preparing historical replay',
    startedAt: Date.now(), elapsedMs: 0, blocks: [], scroll: 0, maxScroll: 0,
    result: null, error: null, abortController,
  };
  state.settingsPanel.modelTestWorkspace = workspace;
  state.settingsTestAbortController = abortController;
  addBlock(workspace, 'session', 'Session', [
    `Historical run: ${run.id}`,
    `Archive: ${run.archivePath || '(unknown)'}`,
    `Stored patch: ${patch.path}`,
    'Project files will not be changed.',
  ]);
  controller.invalidate();
  const timer = setInterval(() => {
    workspace.elapsedMs = Date.now() - workspace.startedAt;
    controller.invalidate();
  }, 500);
  timer.unref?.();
  try {
    const result = await generateChangeDescription({
      settings: state.settings,
      project: state.project,
      plan: run.plan,
      patchContent: patch.content,
    }, {
      signal: abortController.signal,
      onEvent: (event) => updateReplayWorkspace(controller, event),
    });
    workspace.result = result;
    workspace.status = 'Replay completed';
    addBlock(workspace, 'parsed-result', 'Parsed result', [
      ...(result.summary ?? []).map((line) => `Summary: ${line}`),
      `Commit message: ${result.commitMessage || '(none)'}`,
      ...(result.assessment ? [`Assessment: ${result.assessment} · ${result.confidence || 'unknown'} confidence`] : []),
      ...(result.reasons ?? []).map((line) => `Reason: ${line}`),
    ]);
    return true;
  } catch (error) {
    const cancelled = abortController.signal.aborted || error.code === 'cancelled' || error.name === 'AbortError';
    workspace.status = cancelled ? 'Replay cancelled' : 'Replay failed';
    workspace.error = cancelled ? null : error.message;
    addBlock(workspace, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelled' : 'Error', [
      cancelled ? 'The historical replay was cancelled. No project files were changed.' : error.message,
    ]);
    return false;
  } finally {
    clearInterval(timer);
    workspace.running = false;
    workspace.elapsedMs = Date.now() - workspace.startedAt;
    if (state.settingsTestAbortController === abortController) state.settingsTestAbortController = null;
    controller.invalidate();
  }
}

export async function handleModelReplayWorkspaceKey(controller, key) {
  const workspace = controller.state.settingsPanel?.modelTestWorkspace;
  if (!workspace) return false;
  if (key.name === 'escape') {
    if (workspace.running) {
      workspace.status = 'Cancelling replay…';
      workspace.abortController.abort();
    } else controller.state.settingsPanel.modelTestWorkspace = null;
    controller.invalidate();
    return true;
  }
  if (key.name === 'up' || key.name === 'down' || key.name === 'pageup' || key.name === 'pagedown') {
    const amount = key.name === 'pageup' ? -8 : key.name === 'pagedown' ? 8 : key.name === 'up' ? -1 : 1;
    workspace.scroll = clamp(workspace.scroll + amount, 0, workspace.maxScroll ?? 0);
    controller.invalidate();
    return true;
  }
  if (key.printable && key.text?.toLowerCase() === 'c' && workspace.result) {
    const copied = await copyTextToClipboard(replayResultText(workspace), { output: controller.runtime?.output });
    controller.toast(copied ? 'Replay result copied' : 'Clipboard transfer unavailable', copied ? 'success' : 'warning');
    return true;
  }
  if (key.printable && key.text?.toLowerCase() === 'd') {
    const copied = await copyTextToClipboard(replayDiagnosticsText(workspace), { output: controller.runtime?.output });
    controller.toast(copied ? 'Replay diagnostics copied' : 'Clipboard transfer unavailable', copied ? 'success' : 'warning');
    return true;
  }
  return true;
}

export function updateReplayWorkspace(controller, event) {
  const workspace = controller.state.settingsPanel?.modelTestWorkspace;
  if (!workspace) return;
  workspace.status = eventLabel(event, workspace.status);
  if (event.type === 'model-profile') {
    addBlock(workspace, 'model-profile', 'Model profile', [
      `Model: ${event.profile?.requestModel || '(unknown)'}`,
      `Context: ${formatNumber(event.profile?.contextLength)}`,
      `Source: ${event.profile?.source || 'provider metadata'}`,
      `Loaded: ${event.profile?.loadedModel ? 'yes' : 'no'}`,
    ]);
  } else if (event.type === 'delivery-mode') {
    addBlock(workspace, 'delivery', 'Delivery', [
      `Requested: ${event.requestedMode || 'adaptive'}`,
      `Resolved: ${event.deliveryMode}`,
    ]);
  } else if (event.type === 'batch-start') {
    addBlock(workspace, `batch-${event.index}`, `Batch ${event.index} of ${event.total}`, [
      `Files: ${(event.files ?? []).join(', ') || '(not reported)'}`,
      'Streaming model output…',
    ], { streaming: true });
  } else if (event.type === 'batch-complete') {
    const block = findBlock(workspace, `batch-${event.index}`);
    if (block) block.streaming = false;
  } else if (event.type === 'phase') {
    addBlock(workspace, `phase-${event.phase}`, event.label || event.phase, [], { ephemeral: true });
  } else if (event.type === 'request') {
    addLine(workspace, currentRequestBlockId(workspace, event), `${event.transport || 'Local LLM'} · ${event.endpoint || ''} · model ${event.model}`);
  } else if (event.type === 'chunk' && !event.hiddenOutput) {
    const block = ensureStreamBlock(workspace, event);
    block.reasoning = event.reasoning ?? block.reasoning ?? '';
    block.content = event.content ?? block.content ?? '';
    block.streaming = true;
  } else if (event.type === 'complete') {
    const block = latestStreamBlock(workspace);
    if (block) block.streaming = false;
  } else if (event.type === 'patch-budget') {
    addLine(workspace, 'delivery', `Patch tokens: ~${formatNumber(event.patch?.sentEstimatedTokens)}${event.patch?.truncated ? ' · reduced to fit context' : ''}`);
  }
  controller.invalidate();
}

function addBlock(workspace, id, title, lines = [], options = {}) {
  const existing = findBlock(workspace, id);
  if (existing) {
    if (lines.length) existing.lines = [...new Set([...existing.lines, ...lines])];
    Object.assign(existing, options);
    return existing;
  }
  const block = { id, title, lines, reasoning: '', content: '', streaming: false, ...options };
  workspace.blocks.push(block);
  return block;
}

function addLine(workspace, id, line) {
  if (!line) return;
  const block = findBlock(workspace, id) ?? addBlock(workspace, id, id === 'delivery' ? 'Delivery' : 'Request');
  if (!block.lines.includes(line)) block.lines.push(line);
}

function findBlock(workspace, id) {
  return workspace.blocks.find((item) => item.id === id);
}

function ensureStreamBlock(workspace, event) {
  const batch = workspace.blocks.filter((item) => item.id.startsWith('batch-')).at(-1);
  if (batch) return batch;
  const id = event.stage === 'repair' ? 'repair' : event.stage === 'synthesis' ? 'synthesis' : 'response';
  return findBlock(workspace, id) ?? addBlock(workspace, id, titleCase(id), [], { streaming: true });
}

function latestStreamBlock(workspace) {
  return [...workspace.blocks].reverse().find((item) => item.streaming);
}

function currentRequestBlockId(workspace, event) {
  const batch = workspace.blocks.filter((item) => item.id.startsWith('batch-')).at(-1);
  if (batch) return batch.id;
  return event.stage === 'repair' ? 'repair' : event.stage === 'synthesis' ? 'synthesis' : 'request';
}

function eventLabel(event, fallback) {
  if (event.type === 'phase') return event.label || fallback;
  if (event.type === 'batch-start') return `Analyzing batch ${event.index} of ${event.total}`;
  if (event.type === 'chunk') return event.contentDelta ? 'Receiving model response' : 'Model is reasoning';
  if (event.type === 'complete') return 'Parsing model response';
  if (event.type === 'model-load-progress') return `Loading model · ${Math.round(Number(event.progress ?? 0) * 100)}%`;
  return fallback;
}

function replayResultText(workspace) {
  const result = workspace.result;
  return [
    `Historical replay: ${workspace.runId}`,
    '', 'SUMMARY:', ...(result.summary ?? []).map((line) => `- ${line}`),
    '', 'COMMIT MESSAGE:', result.commitMessage || '',
    ...(result.assessment ? ['', 'ASSESSMENT:', result.assessment, 'CONFIDENCE:', result.confidence || '', 'REASONS:', ...(result.reasons ?? []).map((line) => `- ${line}`)] : []),
  ].join('\n');
}

function replayDiagnosticsText(workspace) {
  return [
    `Run: ${workspace.runId}`,
    `Status: ${workspace.status}`,
    `Elapsed: ${(workspace.elapsedMs / 1000).toFixed(1)}s`,
    ...workspace.blocks.flatMap((block) => [
      '', `[${block.title}]`, ...block.lines,
      ...(block.reasoning ? ['Reasoning:', block.reasoning] : []),
      ...(block.content ? ['Response:', block.content] : []),
    ]),
  ].join('\n');
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toLocaleString('en-US') : 'unknown';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
