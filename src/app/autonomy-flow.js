import { requestAutonomyDecision } from '../autonomy/decision-engine.js';
import { canAutonomy, isAutopilotEnabled } from '../autonomy/policies.js';
import { saveRunRecord } from '../runs/store.js';
import { hashText } from '../utils/hash.js';
import { beginLlmProgress } from './llm-progress.js';
import { activeRunSettings } from './runtime-settings.js';

export function autonomyEnabledFor(state, capability) {
  return isAutopilotEnabled(state.workflow) && canAutonomy(state.workflow, capability);
}

export async function decideAtGate(controller, {
  gate,
  capability,
  context,
  allowedActions,
  fallback = 'ask-user',
  label = null,
  validateDecision = null,
  requestDecision = requestAutonomyDecision,
}) {
  const { state } = controller;
  if (!autonomyEnabledFor(state, capability)) return { action: fallback, source: 'manual' };
  state.run.autonomy ??= { mode: state.workflow.autonomy.mode, paused: false, decisions: [], fallbackCount: 0 };
  if (state.run.autonomy.paused) return { action: 'ask-user', source: 'paused' };
  const operation = controller.beginOperation({
    kind: 'llm-decision',
    label: label || `Autopilot decision · ${gate}`,
    onCancel: () => { state.run.autonomy.paused = true; },
  });
  const progress = beginLlmProgress(controller);
  const startedAt = Date.now();
  controller.setStatus(label || `Autopilot is deciding · ${gate}`);
  try {
    const decision = await requestDecision({
      settings: activeRunSettings(state),
      mode: state.workflow.autonomy.mode,
      gate,
      context,
      allowedActions,
      signal: operation.signal,
      onEvent: progress.onEvent,
    });
    const validation = validateDecision ? await validateDecision(decision) : { ok: true, stateHash: decision.stateHash };
    const stateValid = validation === true || validation?.ok !== false;
    const validAction = decision.accepted && stateValid ? decision.action : 'ask-user';
    const record = {
      id: `decision-${(state.run.decisions?.length ?? 0) + 1}`,
      gate,
      source: 'llm',
      mode: state.workflow.autonomy.mode,
      action: validAction,
      proposedAction: decision.action,
      targetId: decision.targetId,
      allowedActions,
      confidence: decision.confidence,
      effectiveConfidence: decision.effectiveConfidence,
      summary: decision.summary,
      evidence: decision.evidence,
      risks: decision.risks,
      conditions: decision.conditions,
      model: decision.model,
      provider: decision.provider,
      promptHash: hashText(`${gate}:${decision.stateHash}:${allowedActions.join(',')}`),
      stateHashBefore: decision.stateHash,
      stateHashAfter: validation?.stateHash ?? decision.stateHash,
      stateDrift: !stateValid,
      durationMs: Date.now() - startedAt,
      accepted: decision.accepted,
      repaired: decision.repaired,
      executionStatus: validAction === 'ask-user' ? 'not-executed' : 'pending',
      executionError: null,
      executedAt: null,
      at: new Date().toISOString(),
    };
    state.run.decisions ??= [];
    state.run.decisions.push(record);
    state.run.autonomy.decisions = state.run.decisions.map((item) => item.id);
    state.run = await saveRunRecord(state.run);
    controller.message('Autopilot decision', [
      `${actionLabel(validAction)} · ${Math.round(decision.effectiveConfidence * 100)}% effective confidence`,
      decision.summary,
      ...decision.risks.map((risk) => `Risk: ${risk}`),
      ...decision.conditions.map((condition) => `Condition: ${condition}`),
      ...(!decision.accepted ? ['Confidence or context quality was below the profile threshold; control returns to you.'] : []),
      ...(!stateValid ? ['Project state changed while the model was deciding; the proposed action was not executed.'] : []),
    ], validAction === 'ask-user' || validAction === 'abort' ? 'warning' : 'choice', {
      collapsedSummary: `Autopilot · ${actionLabel(validAction)} · ${Math.round(decision.effectiveConfidence * 100)}%`,
    });
    return { ...decision, action: validAction, record };
  } catch (error) {
    if (error.code === 'cancelled') {
      state.run.autonomy.paused = true;
      const record = await appendNonModelDecision(state, {
        gate, source: 'cancelled', mode: state.workflow.autonomy.mode, action: 'ask-user',
        allowedActions, summary: 'The active autonomous decision was cancelled by the user.',
        executionStatus: 'not-executed', durationMs: Date.now() - startedAt,
      });
      state.run = await saveRunRecord(state.run);
      controller.message('Autopilot paused', ['The active LLM decision was cancelled. Continue from this checkpoint manually or resume autopilot later.'], 'warning');
      return { action: 'ask-user', source: 'cancelled', error, record };
    }
    state.run.autonomy.fallbackCount = Number(state.run.autonomy.fallbackCount || 0) + 1;
    const record = await appendNonModelDecision(state, {
      gate, source: 'fallback', mode: state.workflow.autonomy.mode, action: fallback,
      allowedActions, summary: error.message, executionStatus: fallback === 'ask-user' ? 'not-executed' : 'pending',
      durationMs: Date.now() - startedAt,
    });
    state.run = await saveRunRecord(state.run);
    controller.message('Autopilot decision unavailable', [error.message, `Fallback: ${actionLabel(fallback)}`], 'warning');
    return { action: fallback, source: 'fallback', error, record };
  } finally {
    progress.stop();
    operation.finish();
  }
}



export async function markAutonomyDecision(controller, decision, executionStatus, details = {}) {
  const { state } = controller;
  const id = decision?.record?.id ?? decision?.id;
  if (!id || !state.run) return false;
  const record = state.run.decisions?.find((item) => item.id === id);
  if (!record) return false;
  record.executionStatus = executionStatus;
  if (executionStatus === 'executing') record.executionStartedAt = new Date().toISOString();
  record.executedAt = ['executed', 'failed'].includes(executionStatus) ? new Date().toISOString() : record.executedAt;
  record.executionError = details.error ? String(details.error.message ?? details.error) : null;
  if (details.result !== undefined) record.executionResult = details.result;
  state.run = await saveRunRecord(state.run);
  return true;
}

async function appendNonModelDecision(state, value) {
  const record = {
    id: `decision-${(state.run.decisions?.length ?? 0) + 1}`,
    targetId: null,
    confidence: null,
    effectiveConfidence: null,
    evidence: [],
    risks: [],
    conditions: [],
    provider: state.runSettings?.llmProvider ?? state.settings?.llmProvider ?? null,
    model: state.runSettings?.llmModel ?? state.settings?.llmModel ?? null,
    promptHash: null,
    stateHashBefore: null,
    stateHashAfter: null,
    stateDrift: false,
    proposedAction: null,
    accepted: false,
    repaired: false,
    executionError: null,
    executedAt: null,
    at: new Date().toISOString(),
    ...value,
  };
  state.run.decisions ??= [];
  state.run.decisions.push(record);
  state.run.autonomy.decisions = state.run.decisions.filter((item) => item.source !== 'user').map((item) => item.id);
  return record;
}

export async function resumeAutopilot(controller) {
  const { state } = controller;
  if (!state.run?.autonomy || state.run.autonomy.mode === 'manual') return false;
  state.run.autonomy.paused = false;
  state.run = await saveRunRecord(state.run);
  controller.message('Autopilot resumed', ['The next unresolved checkpoint may be decided by the configured local model.'], 'choice');
  return true;
}

export async function pauseAutopilot(controller, reason = 'Autopilot paused by the user.') {
  const { state } = controller;
  if (!state.run?.autonomy || state.run.autonomy.mode === 'manual') return false;
  state.run.autonomy.paused = true;
  state.run = await saveRunRecord(state.run);
  controller.message('Autopilot paused', [reason], 'warning');
  return true;
}

export function autopilotPaused(state) {
  return Boolean(state.run?.autonomy?.paused && state.run.autonomy.mode !== 'manual');
}

export function initializeRunAutonomy(run, workflow) {
  run.autonomy = {
    mode: workflow.autonomy?.mode ?? 'manual',
    paused: false,
    decisions: [],
    fallbackCount: 0,
    checkRetries: 0,
    deployRetries: 0,
  };
  return run.autonomy;
}

function actionLabel(value) {
  return String(value ?? '').split('-').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '').join(' ');
}
