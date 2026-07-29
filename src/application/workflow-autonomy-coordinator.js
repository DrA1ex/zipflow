import { requestAutonomyDecision } from '../autonomy/decision-engine.js';
import {
  canAutonomy,
  fullAutopilotWarningRequired,
  isAutopilotEnabled,
} from '../autonomy/policies.js';
import { isLocalLlmEnabled } from '../llm/generate.js';
import { hashText } from '../utils/hash.js';

const LOCAL_WORK_BLOCKED = Symbol('local-work-blocked');

export function workflowAutonomyEnabled(privateState) {
  return Boolean(
    isAutopilotEnabled(privateState?.workflow)
    && isLocalLlmEnabled(privateState?.settings)
    && !fullAutopilotWarningRequired(privateState.workflow)
    && privateState?.autonomy?.paused !== true,
  );
}

export function nextWorkflowAutonomyGate(session) {
  const privateState = session?.executionManifest;
  if (!workflowAutonomyEnabled(privateState)) return null;
  if (privateState.llmReviewStatus === 'running') return null;
  const workflow = privateState.workflow;
  const summary = session.publicSummary ?? {};
  const attention = summary.run?.attention ?? null;
  const mode = workflow.autonomy.mode;
  const gitStatus = privateState.plan?.gitStatus;
  const localWork = ['plan', 'conflicts'].includes(attention)
    ? localWorkGate(privateState, gitStatus, mode)
    : null;
  if (localWork === LOCAL_WORK_BLOCKED) return null;
  if (localWork) return localWork;

  if (attention === 'archive_safety') {
    if (!canAutonomy(workflow, 'decidePlanApplication')) return null;
    return gate('plan-application', 'decidePlanApplication', ['apply', 'abort', 'ask-user'], {
      state: planContext(privateState, summary),
      riskLevel: 'high',
      complete: privateState.llmReviewStatus !== 'running',
    }, 'ask-user', { phase: 'archive-safety' });
  }

  const unresolved = (privateState.decisions ?? []).find((item) => item.decision == null);
  if (unresolved) {
    if (!canAutonomy(workflow, 'decideConflicts')) return null;
    const conflict = (privateState.conflicts ?? []).find(({ path }) => path === unresolved.path);
    return gate('file-conflict', 'decideConflicts', [
      'use-archive', 'keep-local', 'ask-user', 'abort',
    ], {
      state: {
        path: unresolved.path,
        reason: conflict?.reason ?? null,
        kind: conflict?.kind ?? null,
        gitStatus: conflict?.gitStatus ?? null,
      },
      riskLevel: 'high',
      complete: true,
    }, 'ask-user', { path: unresolved.path });
  }

  if (attention === 'plan') {
    if (!canAutonomy(workflow, 'decidePlanApplication')) return null;
    const highRisk = ['suspicious', 'unsuitable'].includes(privateState.safety?.llm?.assessment)
      || ['ambiguous', 'likely-partial'].includes(privateState.safety?.deletionIntent?.assessment)
      || (privateState.safety?.warnings?.length ?? 0) > 0;
    if (mode === 'guarded' && highRisk) return null;
    return gate('plan-application', 'decidePlanApplication', ['apply', 'abort', 'ask-user'], {
      state: planContext(privateState, summary),
      coverage: privateState.llm?.delivery?.coverage ?? null,
      riskLevel: highRisk ? 'high' : 'medium',
      complete: privateState.llmReviewStatus !== 'running',
    }, 'ask-user', { phase: 'plan' });
  }

  if (attention === 'checks_failed') {
    if (!canAutonomy(workflow, 'decideFailedChecks')) return null;
    const retries = Number(privateState.autonomy?.checkRetries ?? 0);
    const maxRetries = Number(workflow.autonomy?.maxCheckRetries ?? 1);
    return gate('failed-checks', 'decideFailedChecks', [
      ...(retries < maxRetries ? ['rerun'] : []),
      ...(summary.run?.backupAvailable ? ['rollback'] : []),
      'keep-uncommitted',
      ...(workflow.autonomy.capabilities?.allowCommitAfterFailedChecks ? ['commit-anyway'] : []),
      'ask-user',
    ], {
      state: {
        checks: privateState.checks ?? null,
        appliedPaths: privateState.applied?.paths ?? [],
        retryCount: retries,
        llmFailureExplanation: privateState.llmFailure ?? null,
      },
      riskLevel: 'high',
      complete: Boolean(privateState.checks),
    }, 'ask-user', { retries });
  }

  if (attention === 'commit' || attention === 'commit_message') {
    if (!canAutonomy(workflow, 'decideResultCommit')) return null;
    const rewriteCandidates = privateState.commitRewriteCandidates ?? [];
    return gate('result-commit', 'decideResultCommit', [
      'create-new',
      ...(mode === 'full' && rewriteCandidates.some(({ kind }) => kind === 'amend')
        ? ['amend-head']
        : []),
      ...(mode === 'full' && rewriteCandidates.some(({ kind }) => kind === 'squash')
        ? ['squash-zipflow-commits']
        : []),
      'skip',
      'ask-user',
    ], {
      state: {
        checksPassed: privateState.checks?.ok !== false,
        appliedPaths: privateState.applied?.paths ?? [],
        messageCandidates: commitMessageCandidates(session),
        rewriteCandidates,
        workflowResultCommit: workflow.git?.resultCommit ?? 'ask',
      },
      riskLevel: privateState.checks?.ok === false ? 'high' : 'medium',
      complete: true,
    }, 'ask-user', { phase: attention });
  }

  if (attention === 'deploy') {
    if (!canAutonomy(workflow, 'decideDeployment')) return null;
    const failed = summary.deployment?.status === 'failed';
    const retries = Number(privateState.autonomy?.deployRetries ?? 0);
    const maxRetries = Number(workflow.autonomy?.maxDeployRetries ?? 1);
    return failed
      ? gate('deployment-failure', 'decideDeployment', [
          ...(retries < maxRetries ? ['retry'] : []),
          'finish-with-error',
          ...(mode === 'full' && summary.run?.backupAvailable ? ['rollback-local-only'] : []),
          'ask-user',
        ], {
          state: { deployment: privateState.deploy ?? null, retries },
          riskLevel: 'high',
          complete: Boolean(privateState.deploy),
        }, 'finish-with-error', { failed: true, retries })
      : gate('deployment', 'decideDeployment', ['run', 'skip', 'ask-user'], {
          state: {
            checksPassed: privateState.checks?.ok !== false,
            commit: privateState.commit ?? null,
            deployment: workflow.deploy,
          },
          riskLevel: privateState.checks?.ok === false ? 'high' : 'medium',
          complete: true,
        }, 'skip', { failed: false });
  }

  return null;
}

export async function decideWorkflowAutonomy({
  session,
  gate: gateRequest = nextWorkflowAutonomyGate(session),
  signal = null,
  onProgress = null,
  requestDecision = requestAutonomyDecision,
  now = () => new Date(),
} = {}) {
  if (!gateRequest) return null;
  const privateState = session.executionManifest;
  const startedAt = Date.now();
  try {
    const decision = await requestDecision({
      settings: privateState.settings,
      mode: privateState.workflow.autonomy.mode,
      gate: gateRequest.gate,
      context: gateRequest.context,
      allowedActions: gateRequest.allowedActions,
      signal,
      onEvent: onProgress ?? (() => {}),
    });
    const action = decision.accepted ? decision.action : 'ask-user';
    return {
      gate: gateRequest,
      decision: { ...decision, action },
      record: decisionRecord({
        session,
        gateRequest,
        decision,
        action,
        durationMs: Date.now() - startedAt,
        at: now().toISOString(),
      }),
      actions: actionSequence(session, gateRequest, action, decision.targetId),
    };
  } catch (error) {
    const cancelled = error?.code === 'cancelled' || signal?.aborted === true;
    const action = cancelled ? 'ask-user' : gateRequest.fallback;
    return {
      gate: gateRequest,
      decision: {
        action,
        accepted: false,
        source: cancelled ? 'cancelled' : 'fallback',
        summary: cancelled
          ? 'The autonomous decision was cancelled.'
          : String(error?.message ?? error),
      },
      record: fallbackRecord({
        session,
        gateRequest,
        action,
        source: cancelled ? 'cancelled' : 'fallback',
        summary: cancelled
          ? 'The autonomous decision was cancelled.'
          : String(error?.message ?? error),
        durationMs: Date.now() - startedAt,
        at: now().toISOString(),
      }),
      actions: actionSequence(session, gateRequest, action, null),
    };
  }
}

export function appendWorkflowAutonomyDecision(privateState, result) {
  const autonomyDecisions = [
    ...(privateState.autonomyDecisions ?? []),
    structuredClone(result.record),
  ];
  const autonomy = {
    mode: privateState.workflow.autonomy.mode,
    paused: result.decision.source === 'cancelled'
      ? true
      : privateState.autonomy?.paused === true,
    decisions: autonomyDecisions.map(({ id }) => id),
    fallbackCount: Number(privateState.autonomy?.fallbackCount ?? 0)
      + (result.decision.source === 'fallback' ? 1 : 0),
    checkRetries: Number(privateState.autonomy?.checkRetries ?? 0)
      + (result.decision.action === 'rerun' ? 1 : 0),
    deployRetries: Number(privateState.autonomy?.deployRetries ?? 0)
      + (result.decision.action === 'retry' ? 1 : 0),
  };
  const localWorkChanges = result.gate.gate === 'local-work'
    ? result.decision.action === 'create-checkpoint'
      ? { autonomyCheckpointPending: true }
      : result.decision.action === 'continue'
        ? { localWorkResolution: 'continued' }
        : {}
    : {};
  return {
    ...structuredClone(privateState),
    ...localWorkChanges,
    autonomyDecisions,
    autonomy,
  };
}

export function publicWorkflowAutonomyDecision(record) {
  if (!record) return null;
  return {
    id: clean(record.id, 128),
    gate: clean(record.gate, 128),
    mode: clean(record.mode, 64),
    action: clean(record.action, 128),
    proposedAction: clean(record.proposedAction, 128) || null,
    confidence: finite(record.confidence),
    effectiveConfidence: finite(record.effectiveConfidence),
    summary: clean(record.summary, 2_000),
    evidence: strings(record.evidence, 8, 2_000),
    risks: strings(record.risks, 8, 2_000),
    conditions: strings(record.conditions, 8, 2_000),
    accepted: record.accepted === true,
    source: clean(record.source, 64),
    executionStatus: clean(record.executionStatus, 64),
    at: record.at,
  };
}

function gate(gateId, capability, allowedActions, context, fallback, metadata) {
  return { gate: gateId, capability, allowedActions, context, fallback, metadata };
}

function planContext(privateState, summary) {
  return {
    plan: {
      counts: privateState.plan?.counts ?? {},
      created: paths(privateState.created),
      updated: paths(privateState.updated),
      deleted: paths(privateState.deleted),
      conflicts: (privateState.conflicts ?? []).map(({ path, reason }) => ({ path, reason })),
    },
    selections: privateState.decisions ?? [],
    archiveSafety: privateState.safety ?? null,
    llmAssessment: privateState.safety?.llm ?? null,
    projectGit: privateState.plan?.gitStatus ? {
      staged: paths(privateState.plan.gitStatus.staged),
      unstaged: paths(privateState.plan.gitStatus.unstaged),
      conflicted: paths(privateState.plan.gitStatus.conflicted),
    } : null,
    runStatus: summary.run?.status ?? null,
  };
}

function commitMessageCandidates(session) {
  const privateState = session.executionManifest;
  const values = [
    privateState.llm?.commitMessage
      ? { id: 'llm', message: privateState.llm.commitMessage }
      : null,
    privateState.metadata?.commitMessage
      ? { id: 'archive-metadata', message: privateState.metadata.commitMessage }
      : null,
    {
      id: 'generated',
      message: `zipflow: apply ${session.run.runId}`,
    },
  ].filter(Boolean);
  return values;
}

function actionSequence(session, gateRequest, action, targetId) {
  const privateState = session.executionManifest;
  if (action === 'ask-user' || action === 'abort') return [];
  if (gateRequest.gate === 'local-work') {
    return action === 'create-checkpoint'
      ? [{ actionId: 'create-checkpoint', input: {} }]
      : [];
  }
  if (gateRequest.gate === 'file-conflict') {
    return [{
      actionId: 'resolve-conflict',
      input: {
        path: gateRequest.metadata.path,
        decision: action === 'use-archive' ? 'archive' : 'keep',
      },
    }];
  }
  if (gateRequest.gate === 'plan-application') {
    if (gateRequest.metadata.phase === 'archive-safety') {
      return [{ actionId: 'acknowledge-archive-safety', input: {} }];
    }
    return action === 'apply' ? [{ actionId: 'approve-plan', input: {} }] : [];
  }
  if (gateRequest.gate === 'failed-checks') {
    if (action === 'rerun') return [{ actionId: 'retry-checks', input: {} }];
    if (action === 'rollback') return [{ actionId: 'rollback', input: {} }];
    if (action === 'keep-uncommitted') return [{ actionId: 'finish', input: {} }];
    if (action === 'commit-anyway') {
      return [
        { actionId: 'keep-changes', input: {} },
        ...commitSequence(session, targetId),
      ];
    }
  }
  if (gateRequest.gate === 'result-commit') {
    if (action === 'skip') return [{ actionId: 'continue-without-commit', input: {} }];
    if (action === 'create-new') return commitSequence(session, targetId);
    if (action === 'amend-head' || action === 'squash-zipflow-commits') {
      const expectedKind = action === 'amend-head' ? 'amend' : 'squash';
      const candidate = privateState.commitRewriteCandidates
        ?.find(({ id, kind }) => id === targetId && kind === expectedKind);
      if (!candidate) return [];
      return [{
        actionId: expectedKind === 'amend' ? 'amend-commit' : 'squash-commits',
        input: {
          targetId: candidate.id,
          message: commitMessageCandidates(session)[0]?.message
            ?? `zipflow: apply ${session.run.runId}`,
        },
      }];
    }
  }
  if (gateRequest.gate === 'deployment') {
    return [{ actionId: action === 'run' ? 'deploy' : 'skip-deploy', input: {} }];
  }
  if (gateRequest.gate === 'deployment-failure') {
    if (action === 'retry') return [{ actionId: 'retry-deploy', input: {} }];
    if (action === 'finish-with-error') {
      return [{ actionId: 'finish-with-deploy-error', input: {} }];
    }
    if (action === 'rollback-local-only') return [{ actionId: 'rollback', input: {} }];
  }
  return [];
}

function commitSequence(session, targetId) {
  const candidates = commitMessageCandidates(session);
  const message = candidates.find(({ id }) => id === targetId)?.message
    ?? candidates[0]?.message
    ?? `zipflow: apply ${session.run.runId}`;
  return [
    { actionId: 'prepare-commit', input: {} },
    { actionId: 'commit', input: { message } },
  ];
}

function localWorkGate(privateState, gitStatus, mode) {
  if (!gitStatus || privateState.localWorkResolution || privateState.autonomyCheckpointPending) {
    return null;
  }
  const staged = paths(gitStatus.staged);
  const unstaged = paths(gitStatus.unstaged);
  const conflicted = paths(gitStatus.conflicted);
  if (!staged.length && !unstaged.length && !conflicted.length) return null;
  if (conflicted.length) return LOCAL_WORK_BLOCKED;
  const planned = new Set([
    ...paths(privateState.created),
    ...paths(privateState.updated),
    ...paths(privateState.deleted),
  ]);
  const stagedOverlap = staged.filter((item) => planned.has(item));
  if (stagedOverlap.length || (mode === 'guarded' && staged.length)) {
    return LOCAL_WORK_BLOCKED;
  }
  return gate('local-work', 'decidePlanApplication', [
    'continue', 'create-checkpoint', 'ask-user', 'abort',
  ], {
    state: {
      gitStatus: { staged, unstaged, conflicted },
      planPaths: [...planned],
    },
    riskLevel: unstaged.some((item) => planned.has(item)) ? 'high' : 'medium',
    complete: true,
  }, 'ask-user', {});
}

function decisionRecord({
  session,
  gateRequest,
  decision,
  action,
  durationMs,
  at,
}) {
  const number = (session.executionManifest.autonomyDecisions?.length ?? 0) + 1;
  return {
    id: `decision-${number}`,
    gate: gateRequest.gate,
    source: 'llm',
    mode: session.executionManifest.workflow.autonomy.mode,
    action,
    proposedAction: decision.action,
    targetId: decision.targetId ?? null,
    allowedActions: gateRequest.allowedActions,
    confidence: decision.confidence,
    effectiveConfidence: decision.effectiveConfidence,
    summary: decision.summary,
    evidence: decision.evidence ?? [],
    risks: decision.risks ?? [],
    conditions: decision.conditions ?? [],
    model: decision.model ?? session.executionManifest.settings?.llmModel ?? null,
    provider: decision.provider ?? session.executionManifest.settings?.llmProvider ?? null,
    promptHash: hashText(`${gateRequest.gate}:${decision.stateHash}:${gateRequest.allowedActions.join(',')}`),
    stateHashBefore: decision.stateHash ?? null,
    stateHashAfter: decision.stateHash ?? null,
    stateDrift: false,
    durationMs,
    accepted: decision.accepted === true,
    repaired: decision.repaired === true,
    executionStatus: action === 'ask-user' ? 'not-executed' : 'pending',
    executionError: null,
    executedAt: null,
    at,
  };
}

function fallbackRecord({ session, gateRequest, action, source, summary, durationMs, at }) {
  const number = (session.executionManifest.autonomyDecisions?.length ?? 0) + 1;
  return {
    id: `decision-${number}`,
    gate: gateRequest.gate,
    source,
    mode: session.executionManifest.workflow.autonomy.mode,
    action,
    proposedAction: null,
    targetId: null,
    allowedActions: gateRequest.allowedActions,
    confidence: null,
    effectiveConfidence: null,
    summary,
    evidence: [],
    risks: [],
    conditions: [],
    model: session.executionManifest.settings?.llmModel ?? null,
    provider: session.executionManifest.settings?.llmProvider ?? null,
    promptHash: null,
    stateHashBefore: null,
    stateHashAfter: null,
    stateDrift: false,
    durationMs,
    accepted: false,
    repaired: false,
    executionStatus: action === 'ask-user' ? 'not-executed' : 'pending',
    executionError: null,
    executedAt: null,
    at,
  };
}

function paths(values) {
  return (Array.isArray(values) ? values : []).map((item) => (
    typeof item === 'string' ? item : item?.path
  )).filter(Boolean);
}

function strings(values, limit, charLimit) {
  return (Array.isArray(values) ? values : [])
    .map((value) => clean(value, charLimit))
    .filter(Boolean)
    .slice(0, limit);
}

function clean(value, limit) {
  return String(value ?? '')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s"'`<>|]+[\\/])*[^\s"'`<>|]*/g, '[redacted-path]')
    .trim()
    .slice(0, limit);
}

function finite(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}
