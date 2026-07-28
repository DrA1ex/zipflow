import path from 'node:path';
import { copyZipflowText } from '../ui/clipboard.js';
import { loadStoredPatch } from '../diff/stored-patch.js';
import { generateChangeDescription } from '../llm/generate.js';
import { listProjectRuns } from '../runs/store.js';
import { exists } from '../utils/fs.js';
import { beginHistoricalAutopilotSimulation } from './settings-autopilot-replay.js';
import { BoundedByteBuffer } from '../utils/byte-buffer.js';
import { llmTasks } from '../llm/tasks.js';
import { isPlainEnter } from './editor-enter.js';


export async function handleReplayDispatch(controller, action) {
  if (action.type === 'model-replay-preview-select') {
    await selectReplayPreview(controller, action.index);
    return true;
  }
  if (action.type === 'model-replay-scroll') {
    scrollReplayWorkspace(controller.state.settingsPanel?.modelTestWorkspace, Number(action.delta) || 0);
    controller.invalidate();
    return true;
  }
  if (action.type === 'model-replay-follow-latest') {
    followReplayLatest(controller.state.settingsPanel?.modelTestWorkspace);
    controller.invalidate();
    return true;
  }
  return false;
}

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

export function startHistoricalModelReplay(controller, runId) {
  const { state } = controller;
  const run = state.settingsPanel?.replayRuns?.find((item) => item.id === runId);
  if (!run || !run.replayAvailable) {
    controller.toast('The stored patch for this run is unavailable', 'warning');
    return false;
  }
  state.settingsPanel.modelTestWorkspace = {
    mode: 'preview', runId, run, archivePath: run.archivePath,
    archiveName: path.basename(String(run.archivePath || 'archive update')),
    previewIndex: 0, running: false, status: 'Ready to replay',
    startedAt: null, elapsedMs: 0, blocks: [], scroll: 0, maxScroll: 0,
    follow: true, unread: 0, unreadBlockIds: new Set(), renderRevision: 0,
    result: null, error: null, errorCode: null, abortController: null,
    requestedTasks: llmTasks(state.settings),
  };
  controller.invalidate();
  return true;
}

export async function beginHistoricalModelReplay(controller) {
  const { state } = controller;
  const workspace = state.settingsPanel?.modelTestWorkspace;
  const run = workspace?.run;
  if (!workspace || workspace.mode !== 'preview' || !run) return false;
  const patch = await loadStoredPatch(run);
  if (!patch) {
    controller.toast('The stored patch for this run is unavailable', 'warning');
    return false;
  }
  const operation = controller.beginOperation({ kind: 'model-replay', label: 'Replaying historical model input' });
  Object.assign(workspace, {
    mode: 'progress', running: true, status: 'Preparing historical replay',
    startedAt: Date.now(), elapsedMs: 0, blocks: [], scroll: 0, maxScroll: 0,
    follow: true, unread: 0, unreadBlockIds: new Set(), renderRevision: 0,
    result: null, error: null, errorCode: null, abortController: { abort: () => operation.abort() },
  });
  state.settingsTestAbortController = { abort: () => operation.abort() };
  addBlock(workspace, 'session', 'Session', [
    `Historical run: ${run.id}`,
    `Archive: ${run.archivePath || '(unknown)'}`,
    `Stored patch: ${patch.path}`,
    'Project files, Git state, backups, and history will not be changed.',
  ], { status: 'done' });
  controller.invalidate();
  const timer = setInterval(() => {
    workspace.elapsedMs = Date.now() - workspace.startedAt;
    controller.invalidate();
  }, 250);
  timer.unref?.();
  try {
    const result = await generateChangeDescription({
      settings: state.settings,
      project: state.project,
      plan: run.plan,
      patchContent: patch.content,
    }, {
      signal: operation.signal,
      onEvent: (event) => updateReplayWorkspace(controller, event),
    });
    workspace.result = result;
    workspace.status = 'Replay completed';
    markActiveBlocks(workspace, 'done');
    addBlock(workspace, 'parsed-result', 'Parsed result', [], { status: 'done', result });
    noteReplayChange(workspace, 'parsed-result');
    return true;
  } catch (error) {
    const cancelled = operation.signal.aborted || error.code === 'cancelled' || error.name === 'AbortError';
    workspace.status = cancelled ? 'Replay cancelled' : 'Replay failed';
    workspace.error = cancelled ? null : error.message;
    workspace.errorCode = cancelled ? null : error.code ?? 'replay_failed';
    markActiveBlocks(workspace, cancelled ? 'pending' : 'error');
    addBlock(workspace, cancelled ? 'cancelled' : 'error', cancelled ? 'Cancelled' : 'Error', cancelled
      ? ['The historical replay was cancelled. No project files were changed.']
      : replayFailureLines(error), { status: cancelled ? 'pending' : 'error' });
    noteReplayChange(workspace, cancelled ? 'cancelled' : 'error');
    return false;
  } finally {
    clearInterval(timer);
    if (workspace.invalidateTimer) clearTimeout(workspace.invalidateTimer);
    workspace.invalidateTimer = null;
    workspace.running = false;
    workspace.elapsedMs = Date.now() - workspace.startedAt;
    state.settingsTestAbortController = null;
    operation.finish();
    controller.invalidate();
  }
}

export async function handleModelReplayWorkspaceKey(controller, key) {
  const workspace = controller.state.settingsPanel?.modelTestWorkspace;
  if (!workspace) return false;
  if (workspace.mode === 'preview') return handlePreviewKey(controller, workspace, key);
  if (key.name === 'escape') {
    if (workspace.running) {
      workspace.status = 'Cancelling replay…';
      workspace.abortController?.abort();
    } else controller.state.settingsPanel.modelTestWorkspace = null;
    controller.invalidate();
    return true;
  }
  if (['up', 'down', 'page-up', 'page-down', 'pageup', 'pagedown', 'home', 'end'].includes(key.name)) {
    if (key.name === 'end') followReplayLatest(workspace);
    else if (key.name === 'home') scrollReplayWorkspace(workspace, -Number.MAX_SAFE_INTEGER);
    else {
      const page = key.name === 'page-up' || key.name === 'pageup' ? -8 : key.name === 'page-down' || key.name === 'pagedown' ? 8 : key.name === 'up' ? -1 : 1;
      scrollReplayWorkspace(workspace, page);
    }
    controller.invalidate();
    return true;
  }
  if (key.printable && key.text?.toLowerCase() === 'c' && workspace.result) {
    const copied = await copyZipflowText(workspace.kind === 'autopilot' ? autopilotResultText(workspace) : replayResultText(workspace), { output: controller.runtime?.output });
    controller.toast(copied ? 'Replay result copied' : 'Clipboard transfer unavailable', copied ? 'success' : 'warning');
    return true;
  }
  if (key.printable && key.text?.toLowerCase() === 'd') {
    const copied = await copyZipflowText(replayDiagnosticsText(workspace), { output: controller.runtime?.output });
    controller.toast(copied ? 'Replay diagnostics copied' : 'Clipboard transfer unavailable', copied ? 'success' : 'warning');
    return true;
  }
  return true;
}

async function handlePreviewKey(controller, workspace, key) {
  if (key.name === 'escape') {
    controller.state.settingsPanel.modelTestWorkspace = null;
    controller.invalidate();
    return true;
  }
  if (key.name === 'up' || key.name === 'down') {
    workspace.previewIndex = workspace.previewIndex === 0 ? 1 : 0;
    controller.invalidate();
    return true;
  }
  if (isPlainEnter(key) || key.name === 'space') {
    if ((workspace.previewIndex ?? 0) === 1) {
      controller.state.settingsPanel.modelTestWorkspace = null;
      controller.invalidate();
      return true;
    }
    await beginWorkspaceReplay(controller, workspace);
    return true;
  }
  return true;
}

async function beginWorkspaceReplay(controller, workspace) {
  return workspace?.kind === 'autopilot'
    ? beginHistoricalAutopilotSimulation(controller)
    : beginHistoricalModelReplay(controller);
}

export async function selectReplayPreview(controller, index) {
  const workspace = controller.state.settingsPanel?.modelTestWorkspace;
  if (!workspace || workspace.mode !== 'preview') return;
  workspace.previewIndex = clamp(Number(index) || 0, 0, 1);
  if (workspace.previewIndex === 0) await beginWorkspaceReplay(controller, workspace);
  else {
    controller.state.settingsPanel.modelTestWorkspace = null;
    controller.invalidate();
  }
}

export function scrollReplayWorkspace(workspace, delta) {
  if (!workspace) return;
  workspace.scroll = clamp((workspace.scroll ?? 0) + delta, 0, workspace.maxScroll ?? 0);
  workspace.follow = workspace.scroll >= (workspace.maxScroll ?? 0);
  if (workspace.follow) clearReplayUnread(workspace);
}

export function followReplayLatest(workspace) {
  if (!workspace) return;
  workspace.follow = true;
  workspace.scroll = workspace.maxScroll ?? 0;
  clearReplayUnread(workspace);
}

export function updateReplayWorkspace(controller, event) {
  const workspace = controller.state.settingsPanel?.modelTestWorkspace;
  if (!workspace || workspace.mode !== 'progress') return;
  workspace.status = eventLabel(event, workspace.status);
  let changedId = null;
  if (event.type === 'model-profile') {
    markActiveBlocks(workspace, 'done');
    changedId = 'model-profile';
    addBlock(workspace, changedId, 'Model profile', [
      `Model: ${event.profile?.requestModel || '(unknown)'}`,
      `Context: ${formatNumber(event.profile?.contextLength)}`,
      `Source: ${event.profile?.source || 'provider metadata'}`,
      `Loaded: ${event.profile?.loadedModel ? 'yes' : 'no'}`,
    ], { status: 'done' });
  } else if (event.type === 'delivery-mode') {
    changedId = 'delivery';
    addBlock(workspace, changedId, 'Delivery', [
      `Requested: ${event.requestedMode || 'adaptive'}`,
      `Resolved: ${event.deliveryMode}`,
      ...(event.coverage ? coverageLines(event.coverage) : []),
    ], { status: 'done' });
  } else if (event.type === 'batch-start') {
    markActiveBlocks(workspace, 'done');
    changedId = `batch-${event.index}`;
    addBlock(workspace, changedId, `Batch ${event.index} of ${event.total}`, [
      `Files: ${(event.files ?? []).join(', ') || '(not reported)'}`,
      'Streaming model output…',
    ], { streaming: true, status: 'active' });
  } else if (event.type === 'batch-complete') {
    changedId = `batch-${event.index}`;
    const block = findBlock(workspace, changedId);
    if (block) Object.assign(block, { streaming: false, status: 'done' });
  } else if (event.type === 'phase') {
    markActiveBlocks(workspace, 'done');
    changedId = `phase-${event.phase}`;
    addBlock(workspace, changedId, event.label || event.phase, [], { ephemeral: true, status: 'active' });
  } else if (event.type === 'request') {
    changedId = currentRequestBlockId(workspace, event);
    addLine(workspace, changedId, `${event.transport || 'Local LLM'} · ${event.endpoint || ''} · model ${event.model}`);
  } else if (event.type === 'chunk' && !event.hiddenOutput) {
    const block = ensureStreamBlock(workspace, event);
    changedId = block.id;
    appendReplayStream(workspace, block, 'reasoning', event.reasoningDelta, event.reasoning);
    appendReplayStream(workspace, block, 'content', event.contentDelta, event.content);
    block.streaming = true;
    block.status = 'active';
  } else if (event.type === 'complete') {
    const block = latestStreamBlock(workspace);
    if (block) {
      changedId = block.id;
      block.streaming = false;
      block.status = 'done';
    }
  } else if (event.type === 'patch-budget') {
    changedId = 'delivery';
    addLine(workspace, 'delivery', `Patch tokens: ~${formatNumber(event.patch?.sentEstimatedTokens)}${event.patch?.truncated ? ' · reduced to fit context' : ''}`);
  } else if (event.type === 'coverage') {
    changedId = 'delivery';
    for (const line of coverageLines(event)) addLine(workspace, 'delivery', line);
  }
  if (changedId) {
    touchReplay(workspace);
    noteReplayChange(workspace, changedId);
  }
  if (event.type === 'chunk') scheduleReplayInvalidate(controller, workspace);
  else controller.invalidate();
}

function appendReplayStream(workspace, block, key, delta, complete) {
  const bufferKey = `${key}Buffer`;
  if (!block[bufferKey]) block[bufferKey] = new BoundedByteBuffer(2 * 1024 * 1024);
  if (delta) {
    if (block[bufferKey].byteLength === 0 && complete != null && String(complete) !== String(delta)) block[bufferKey].append(complete);
    else block[bufferKey].append(delta);
  } else if (complete != null) {
    block[bufferKey] = new BoundedByteBuffer(2 * 1024 * 1024);
    block[bufferKey].append(complete);
  }
  touchReplay(workspace);
}

function replayStreamText(block, key) {
  return String(block?.[key] ?? '');
}

function coverageLines(coverage) {
  return [
    coverage.reviewedFiles != null ? `Reviewed content: ${coverage.reviewedFiles} of ${coverage.totalFiles ?? coverage.reviewedFiles} files` : null,
    coverage.manifestFiles != null ? `Changed-path manifest: ${coverage.manifestFiles} files` : null,
    coverage.patchCoveragePercent != null ? `Patch coverage: ${coverage.patchCoveragePercent}%` : null,
  ].filter(Boolean);
}

function addBlock(workspace, id, title, lines = [], options = {}) {
  const existing = findBlock(workspace, id);
  if (existing) {
    if (lines.length) existing.lines = [...new Set([...existing.lines, ...lines])];
    Object.assign(existing, options);
    touchReplay(workspace);
    return existing;
  }
  const block = { id, title, lines, streaming: false, status: 'pending' };
  Object.defineProperties(block, {
    _reasoning: { value: '', writable: true },
    _content: { value: '', writable: true },
    reasoning: {
      enumerable: true,
      get() { return this.reasoningBuffer?.toString() ?? this._reasoning; },
      set(value) { this._reasoning = String(value ?? ''); },
    },
    content: {
      enumerable: true,
      get() { return this.contentBuffer?.toString() ?? this._content; },
      set(value) { this._content = String(value ?? ''); },
    },
  });
  Object.assign(block, options);
  workspace.blocks.push(block);
  touchReplay(workspace);
  return block;
}

function addLine(workspace, id, line) {
  if (!line) return;
  const block = findBlock(workspace, id) ?? addBlock(workspace, id, id === 'delivery' ? 'Delivery' : 'Request', [], { status: 'active' });
  if (!block.lines.includes(line)) {
    block.lines.push(line);
    touchReplay(workspace);
  }
}

function findBlock(workspace, id) {
  return workspace.blocks.find((item) => item.id === id);
}

function ensureStreamBlock(workspace, event) {
  const batch = workspace.blocks.filter((item) => item.id.startsWith('batch-')).at(-1);
  if (batch) return batch;
  const id = event.stage === 'repair' ? 'repair' : event.stage === 'synthesis' ? 'synthesis' : 'response';
  return findBlock(workspace, id) ?? addBlock(workspace, id, titleCase(id), [], { streaming: true, status: 'active' });
}

function latestStreamBlock(workspace) {
  return [...workspace.blocks].reverse().find((item) => item.streaming);
}

function currentRequestBlockId(workspace, event) {
  const batch = workspace.blocks.filter((item) => item.id.startsWith('batch-')).at(-1);
  if (batch) return batch.id;
  return event.stage === 'repair' ? 'repair' : event.stage === 'synthesis' ? 'synthesis' : 'request';
}

function markActiveBlocks(workspace, status = 'done') {
  let changed = false;
  for (const block of workspace.blocks) {
    if (block.status === 'active' || block.streaming) {
      Object.assign(block, { status, streaming: false });
      changed = true;
    }
  }
  if (changed) touchReplay(workspace);
}

function replayFailureLines(error) {
  const lines = [String(error?.message || 'The model replay failed.')];
  if (error?.code === 'context_exceeded') {
    lines.push('The model likely reached its context or output-token limit. Reduce the delivered patch, choose chunked delivery, or use a model with a larger context window.');
  } else if (error?.code === 'incomplete_generation') {
    lines.push('The provider closed the response before sending a successful completion event. Check the model server logs and retry.');
  }
  lines.push('Partial model output was preserved. Press D to copy replay diagnostics.');
  return lines;
}

function scheduleReplayInvalidate(controller, workspace) {
  if (workspace.invalidateTimer) return;
  workspace.invalidateTimer = setTimeout(() => {
    workspace.invalidateTimer = null;
    controller.invalidate();
  }, 50);
  workspace.invalidateTimer.unref?.();
}

function touchReplay(workspace) {
  workspace.renderRevision = (workspace.renderRevision ?? 0) + 1;
}

function noteReplayChange(workspace, blockId) {
  if (workspace.follow !== false) return;
  workspace.unreadBlockIds ??= new Set();
  workspace.unreadBlockIds.add(blockId);
  workspace.unread = workspace.unreadBlockIds.size;
}

function clearReplayUnread(workspace) {
  workspace.unread = 0;
  workspace.unreadBlockIds?.clear?.();
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

function autopilotResultText(workspace) {
  const result = workspace.result;
  if (!result?.modes) return `Historical autopilot simulation: ${workspace.runId}`;
  return [
    `Historical autopilot simulation: ${workspace.runId}`,
    ...['guarded', 'full'].flatMap((mode) => [
      '', `${mode.toUpperCase()}:`,
      ...(result.modes[mode]?.decisions ?? []).flatMap((decision) => [
        `- ${decision.label}: ${decision.action}${decision.proposedAction && decision.proposedAction !== decision.action ? ` (proposed ${decision.proposedAction})` : ''}`,
        `  ${decision.summary}`,
      ]),
    ]),
  ].join('\n');
}

function replayDiagnosticsText(workspace) {
  return [
    `Run: ${workspace.runId}`,
    `Status: ${workspace.status}`,
    `Elapsed: ${(workspace.elapsedMs / 1000).toFixed(1)}s`,
    ...workspace.blocks.flatMap((block) => [
      '', `[${block.title}]`, ...block.lines,
      ...(replayStreamText(block, 'reasoning') ? ['Reasoning:', replayStreamText(block, 'reasoning')] : []),
      ...(replayStreamText(block, 'content') ? ['Response:', replayStreamText(block, 'content')] : []),
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
