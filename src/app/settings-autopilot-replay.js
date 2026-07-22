import path from 'node:path';
import { requestAutonomyDecision } from '../autonomy/decision-engine.js';
import { autonomyForMode } from '../autonomy/policies.js';
import { listProjectRuns } from '../runs/store.js';

const MODES = ['guarded', 'full'];

export async function loadAutopilotReplayRuns(controller) {
  const { state } = controller;
  if (!state.project) return [];
  const runs = await listProjectRuns(state.project.root, { limit: 60 });
  const result = runs.filter((run) => !run.kind && run.plan?.counts).map((run) => ({
    ...run,
    autopilotReplayAvailable: historicalAutopilotScenarios(run, 'full').length > 0,
  }));
  state.settingsPanel.autopilotReplayRuns = result;
  return result;
}

export function startHistoricalAutopilotSimulation(controller, runId) {
  const { state } = controller;
  const run = state.settingsPanel?.autopilotReplayRuns?.find((item) => item.id === runId);
  if (!run?.autopilotReplayAvailable) {
    controller.toast('This historical run has no decisions to simulate', 'warning');
    return false;
  }
  state.settingsPanel.modelTestWorkspace = {
    kind: 'autopilot', mode: 'preview', runId, run,
    archivePath: run.archivePath,
    archiveName: path.basename(String(run.archivePath || 'archive update')),
    previewIndex: 0, running: false, status: 'Ready to simulate',
    startedAt: null, elapsedMs: 0, blocks: [], scroll: 0, maxScroll: 0,
    follow: true, unread: 0, unreadBlockIds: new Set(),
    result: null, error: null, abortController: null,
  };
  controller.invalidate();
  return true;
}

export async function beginHistoricalAutopilotSimulation(controller) {
  const { state } = controller;
  const workspace = state.settingsPanel?.modelTestWorkspace;
  const run = workspace?.run;
  if (!workspace || workspace.kind !== 'autopilot' || workspace.mode !== 'preview' || !run) return false;
  const operation = controller.beginOperation({ kind: 'autopilot-simulation', label: 'Simulating historical autopilot decisions' });
  Object.assign(workspace, {
    mode: 'progress', running: true, status: 'Preparing autopilot simulation',
    startedAt: Date.now(), elapsedMs: 0, blocks: [], scroll: 0, maxScroll: 0,
    follow: true, unread: 0, unreadBlockIds: new Set(), result: null, error: null,
    abortController: { abort: () => operation.abort() },
  });
  state.settingsTestAbortController = { abort: () => operation.abort() };
  pushBlock(workspace, {
    id: 'session', title: 'Simulation scope', status: 'done',
    lines: [
      `Historical run: ${run.id}`,
      `Archive: ${run.archivePath || '(unknown)'}`,
      'Guarded and Full autopilot are evaluated independently with the current local LLM settings.',
      'This is read-only: project files, Git state, backups, archives, and run history are not changed.',
    ],
  });
  controller.invalidate();
  const timer = setInterval(() => {
    workspace.elapsedMs = Date.now() - workspace.startedAt;
    controller.invalidate();
  }, 250);
  timer.unref?.();
  try {
    const result = await simulateHistoricalAutopilotRun({
      run,
      settings: state.settings,
      signal: operation.signal,
      onEvent: (event) => updateSimulationEvent(controller, event),
      onDecision: ({ mode, scenario, result: decision }) => {
        pushDecisionBlock(workspace, mode, scenario, decision);
        workspace.status = `${mode === 'guarded' ? 'Guarded' : 'Full'} · ${scenario.label}`;
        controller.invalidate();
      },
    });
    workspace.result = result;
    workspace.status = 'Autopilot simulation completed';
    pushBlock(workspace, {
      id: 'autopilot-result', title: 'Comparison', status: 'done', result,
      lines: comparisonSummary(result),
    });
    return true;
  } catch (error) {
    const cancelled = operation.signal.aborted || error?.name === 'AbortError' || ['ABORT_ERR', 'cancelled'].includes(error?.code);
    workspace.status = cancelled ? 'Autopilot simulation cancelled' : 'Autopilot simulation failed';
    workspace.error = cancelled ? null : error.message;
    pushBlock(workspace, {
      id: cancelled ? 'cancelled' : 'error', title: cancelled ? 'Cancelled' : 'Error',
      status: cancelled ? 'pending' : 'error',
      lines: [cancelled ? 'The simulation was cancelled. Nothing was changed.' : error.message],
    });
    return false;
  } finally {
    clearInterval(timer);
    workspace.running = false;
    workspace.elapsedMs = Date.now() - workspace.startedAt;
    state.settingsTestAbortController = null;
    operation.finish();
    controller.invalidate();
  }
}

export async function simulateHistoricalAutopilotRun({
  run,
  settings,
  signal = null,
  onEvent = () => {},
  onDecision = () => {},
  requestDecision = requestAutonomyDecision,
}) {
  const result = { runId: run.id, modes: {} };
  for (const mode of MODES) {
    const decisions = [];
    for (const scenario of historicalAutopilotScenarios(run, mode)) {
      if (signal?.aborted) throw abortError();
      let decision;
      if (scenario.policyDecision) {
        decision = {
          gate: scenario.gate,
          action: scenario.policyDecision,
          proposedAction: null,
          targetId: null,
          confidence: null,
          effectiveConfidence: null,
          accepted: true,
          source: 'policy',
          summary: scenario.policySummary,
          evidence: scenario.policyEvidence ?? [],
          risks: scenario.policyRisks ?? [],
          conditions: [],
        };
      } else {
        const proposed = await requestDecision({
          settings,
          mode,
          gate: scenario.gate,
          context: scenario.context,
          allowedActions: scenario.allowedActions,
          signal,
          onEvent: (event) => onEvent({ ...event, simulationMode: mode, simulationGate: scenario.gate }),
        });
        decision = {
          ...proposed,
          proposedAction: proposed.action,
          action: proposed.accepted ? proposed.action : 'ask-user',
          source: proposed.accepted ? 'llm' : 'confidence-fallback',
        };
      }
      const entry = { ...decision, label: scenario.label, allowedActions: scenario.allowedActions };
      decisions.push(entry);
      onDecision({ mode, scenario, result: entry });
    }
    result.modes[mode] = {
      profile: autonomyForMode(mode),
      decisions,
      automatic: decisions.filter((item) => !['ask-user'].includes(item.action)).length,
      asksUser: decisions.filter((item) => item.action === 'ask-user').length,
    };
  }
  return result;
}

export function historicalAutopilotScenarios(run, mode) {
  const counts = run.plan?.counts ?? {};
  const totalChanges = Number(counts.created ?? 0) + Number(counts.updated ?? 0) + Number(counts.deleted ?? 0);
  const conflicts = arrayOf(run?.plan?.conflicts);
  const conflictCount = Number(counts.conflicts ?? conflicts.length ?? 0);
  const failedChecks = Boolean(run.checks?.failed || run.checks?.cancelled || run.checks?.ok === false);
  const appliedPaths = arrayOf(run?.applied?.paths ?? run?.applied?.changedPaths);
  const scenarios = [];
  if (totalChanges > 0) scenarios.push({
    gate: 'plan-application', label: 'Apply update plan', capability: 'decidePlanApplication',
    allowedActions: ['apply', 'ask-user'],
    context: {
      state: {
        historicalRunId: run.id,
        archivePath: run.archivePath,
        plan: compactPlan(run.plan),
        archiveSafety: run.archiveSafety ?? null,
        previousDecision: findHistoricalDecision(run, 'plan-application'),
      },
      riskLevel: riskFromRun(run), complete: true,
    },
  });
  if (conflictCount > 0) {
    if (mode === 'guarded') scenarios.push(policyScenario({
      gate: 'conflicts', label: 'Resolve file conflicts', action: 'ask-user',
      summary: 'Guarded autopilot leaves file-version conflicts to the user.',
      evidence: [`${conflictCount} conflict${conflictCount === 1 ? '' : 's'} recorded in the historical plan.`],
      risks: ['Choosing the wrong version can discard local work.'],
    }));
    else scenarios.push({
      gate: 'conflicts', label: 'Resolve file conflicts', capability: 'decideConflicts',
      allowedActions: ['use-archive', 'keep-local', 'ask-user'],
      context: {
        state: {
          historicalRunId: run.id,
          conflicts: conflicts.slice(0, 40).map(compactConflict),
          conflictCount,
          previousDecision: findHistoricalDecision(run, 'conflicts'),
        },
        riskLevel: 'high', complete: conflicts.length > 0,
      },
    });
  }
  if (failedChecks) scenarios.push({
    gate: 'failed-checks', label: 'Handle failed checks', capability: 'decideFailedChecks',
    allowedActions: mode === 'full'
      ? ['rerun', 'rollback', 'keep-uncommitted', 'commit-anyway', 'ask-user']
      : ['rerun', 'rollback', 'keep-uncommitted', 'ask-user'],
    context: {
      state: {
        historicalRunId: run.id,
        checks: compactChecks(run.checks),
        appliedPaths,
        previousDecision: findHistoricalDecision(run, 'failed-checks'),
      },
      riskLevel: 'high', complete: Boolean(run.checks?.results?.length),
    },
  });
  if (totalChanges > 0 || appliedPaths.length > 0) scenarios.push({
    gate: 'result-commit', label: 'Record the result in Git', capability: 'decideResultCommit',
    allowedActions: ['skip', 'create-new', 'ask-user'],
    context: {
      state: {
        historicalRunId: run.id,
        checksPassed: !failedChecks,
        appliedPaths,
        historicalCommit: compactCommit(run.commit),
        previousDecision: findHistoricalDecision(run, 'result-commit'),
        messageCandidates: [{ id: 'historical', message: run.commit?.message || run.llm?.commitMessage || 'Apply archive update' }],
      },
      riskLevel: failedChecks ? 'high' : 'medium', complete: true,
    },
  });
  if (run.deploy) {
    if (failedChecks && mode === 'guarded') scenarios.push(policyScenario({
      gate: 'deployment', label: 'Run deployment', action: 'skip',
      summary: 'Guarded autopilot does not deploy after failed checks.',
      evidence: ['The historical run contains failed or cancelled checks.'],
      risks: ['Deploying an unverified update can affect external systems.'],
    }));
    else scenarios.push({
      gate: 'deployment', label: 'Run deployment', capability: 'decideDeployment',
      allowedActions: ['run', 'skip', 'ask-user'],
      context: {
        state: {
          historicalRunId: run.id,
          checksPassed: !failedChecks,
          historicalCommit: compactCommit(run.commit),
          deployment: compactDeploy(run.deploy),
          previousDecision: findHistoricalDecision(run, 'deployment'),
        },
        riskLevel: failedChecks ? 'high' : 'medium', complete: true,
      },
    });
  }
  return scenarios;
}

function policyScenario({ gate, label, action, summary, evidence, risks }) {
  return {
    gate, label, allowedActions: [action], policyDecision: action,
    policySummary: summary, policyEvidence: evidence, policyRisks: risks,
  };
}

function compactPlan(plan = {}) {
  return {
    counts: plan.counts ?? null,
    created: arrayOf(plan.created).slice(0, 50),
    updated: arrayOf(plan.updated).slice(0, 50),
    deleted: arrayOf(plan.deleted).slice(0, 50),
    conflictCount: plan.conflicts?.length ?? plan.counts?.conflicts ?? 0,
  };
}

function compactConflict(value) {
  if (typeof value === 'string') return { path: value };
  return { path: value?.path ?? null, kind: value?.kind ?? null, reason: value?.reason ?? null };
}

function compactChecks(checks) {
  if (!checks) return null;
  return {
    ok: checks.ok, passed: checks.passed, failed: checks.failed, cancelled: checks.cancelled,
    results: arrayOf(checks.results).filter((item) => item && typeof item === 'object').map((item) => ({
      name: item.name, required: item.required, ok: item.ok, code: item.code, signal: item.signal,
      timedOut: item.timedOut, durationMs: item.durationMs,
      stdout: String(item.stdout ?? '').slice(-4000), stderr: String(item.stderr ?? '').slice(-4000),
    })),
  };
}

function compactCommit(commit) {
  if (!commit) return null;
  return {
    created: commit.created ?? commit.ok ?? null,
    hash: commit.hash ?? commit.commit ?? null,
    message: commit.message ?? null,
    skipped: commit.skipped ?? null,
  };
}

function compactDeploy(deploy) {
  if (!deploy) return null;
  return {
    ok: deploy.ok, code: deploy.code, signal: deploy.signal, timedOut: deploy.timedOut,
    commandText: deploy.commandText ?? deploy.command ?? null,
    durationMs: deploy.durationMs,
    stdout: String(deploy.stdout ?? '').slice(-4000), stderr: String(deploy.stderr ?? '').slice(-4000),
  };
}

function findHistoricalDecision(run, gate) {
  return [
    ...arrayOf(run?.autonomy?.decisions),
    ...arrayOf(run?.decisions),
  ].filter((item) => item && typeof item === 'object')
    .find((item) => item.gate === gate) ?? null;
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function riskFromRun(run) {
  if (run.archiveSafety?.level === 'danger' || (run.plan?.counts?.conflicts ?? 0) > 0) return 'high';
  if (run.archiveSafety?.warnings?.length || (run.plan?.counts?.deleted ?? 0) > 0) return 'medium';
  return 'low';
}

function pushDecisionBlock(workspace, mode, scenario, decision) {
  const confidence = decision.effectiveConfidence == null ? 'policy' : `${Math.round(decision.effectiveConfidence * 100)}%`;
  pushBlock(workspace, {
    id: `${mode}:${scenario.gate}`,
    title: `${mode === 'guarded' ? 'Guarded' : 'Full'} · ${scenario.label}`,
    status: decision.action === 'ask-user' ? 'pending' : 'done',
    lines: [
      `Decision: ${decision.action}${decision.proposedAction && decision.proposedAction !== decision.action ? ` · proposed ${decision.proposedAction}` : ''}`,
      `Confidence: ${confidence} · source ${decision.source}`,
      decision.summary,
      ...(decision.evidence ?? []).map((line) => `Evidence: ${line}`),
      ...(decision.risks ?? []).map((line) => `Risk: ${line}`),
    ].filter(Boolean),
  });
}

function pushBlock(workspace, block) {
  const index = workspace.blocks.findIndex((item) => item.id === block.id);
  if (index >= 0) workspace.blocks[index] = { ...workspace.blocks[index], ...block };
  else workspace.blocks.push({ lines: [], reasoning: '', content: '', streaming: false, status: 'pending', ...block });
  if (workspace.follow === false) {
    workspace.unreadBlockIds ??= new Set();
    workspace.unreadBlockIds.add(block.id);
    workspace.unread = workspace.unreadBlockIds.size;
  }
}

function updateSimulationEvent(controller, event) {
  const workspace = controller.state.settingsPanel?.modelTestWorkspace;
  if (!workspace || workspace.kind !== 'autopilot') return;
  if (event.type === 'chunk' && !event.hiddenOutput) {
    const id = `stream:${event.simulationMode}:${event.simulationGate}`;
    pushBlock(workspace, {
      id, title: `${event.simulationMode} · ${event.simulationGate} · model response`, status: 'active', streaming: true,
      reasoning: event.reasoning ?? '', content: event.content ?? '', lines: [],
    });
  } else if (event.type === 'complete') {
    const id = `stream:${event.simulationMode}:${event.simulationGate}`;
    const block = workspace.blocks.find((item) => item.id === id);
    if (block) Object.assign(block, { status: 'done', streaming: false });
  } else if (event.type === 'request') {
    workspace.status = `${event.simulationMode} · ${event.simulationGate} · contacting model`;
  }
  controller.invalidate();
}

function comparisonSummary(result) {
  const guarded = result.modes.guarded;
  const full = result.modes.full;
  return [
    `Guarded: ${guarded.automatic} automatic · ${guarded.asksUser} ask user`,
    `Full: ${full.automatic} automatic · ${full.asksUser} ask user`,
    'The simulation reports what the current model would propose; deterministic Zipflow protections still remain authoritative in real runs.',
  ];
}

function abortError() {
  const error = new Error('Autopilot simulation cancelled.');
  error.name = 'AbortError';
  error.code = 'cancelled';
  return error;
}
