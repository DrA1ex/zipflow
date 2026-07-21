import { decideAtGate, autonomyEnabledFor, markAutonomyDecision } from './autonomy-flow.js';
import { getGitStatus } from '../git/repository.js';
import { gitStateValidator } from './run-plan-autonomy.js';
import { captureRunExecutionState, runExecutionStateValidator } from './run-state-integrity.js';

export async function handleFailedChecksAutonomy(controller, {
  failedCheck,
  rerun,
  rollback,
  keepUncommitted,
  commitAnyway,
}) {
  const { state } = controller;
  if (!autonomyEnabledFor(state, 'decideFailedChecks')) return false;
  const retries = Number(state.run.autonomy?.checkRetries ?? 0);
  const maxRetries = Number(state.workflow.autonomy?.maxCheckRetries ?? 1);
  const allowedActions = [
    ...(retries < maxRetries ? ['rerun'] : []),
    'rollback', 'keep-uncommitted',
    ...(state.workflow.autonomy?.capabilities?.allowCommitAfterFailedChecks ? ['commit-anyway'] : []),
    'ask-user',
  ];
  const gitStatus = await getGitStatus(state.project.root).catch(() => null);
  const decision = await decideAtGate(controller, {
    gate: 'failed-checks', capability: 'decideFailedChecks', allowedActions,
    fallback: 'ask-user', label: 'Autopilot is reviewing failed checks',
    context: {
      state: {
        failedCheck: serializeCheck(failedCheck),
        allChecks: state.run.checks?.results?.map(serializeCheck) ?? [],
        changedPaths: state.run.applied?.changedPaths ?? [],
        plan: state.run.plan,
        llmFailureExplanation: state.run.llmFailure?.text ?? state.run.llmFailure ?? null,
        historicalRetryCount: retries,
        gitStatus: serializeGitStatus(gitStatus),
      },
      riskLevel: 'high',
      complete: Boolean(failedCheck?.stdout || failedCheck?.stderr),
    },
  });
  if (decision.action === 'rerun') {
    state.run.autonomy.checkRetries = retries + 1;
    await executeDecision(controller, decision, rerun, { checkRetry: state.run.autonomy.checkRetries });
    return true;
  }
  if (decision.action === 'rollback') { await executeDecision(controller, decision, rollback); return true; }
  if (decision.action === 'keep-uncommitted') { await executeDecision(controller, decision, keepUncommitted); return true; }
  if (decision.action === 'commit-anyway') { await executeDecision(controller, decision, commitAnyway); return true; }
  return false;
}

export async function decideResultCommit(controller, {
  failedChecks = false,
  candidates,
  rewriteCandidates = [],
  createNew,
  amendHead,
  squash,
  skip,
}) {
  const { state } = controller;
  if (!autonomyEnabledFor(state, 'decideResultCommit')) return false;
  if (!state.run.applied?.paths?.length || state.workflow.git.resultCommit === 'never') {
    await skip();
    return true;
  }
  const allowRewrite = autonomyEnabledFor(state, 'decideCommitRewrite') && state.workflow.autonomy.capabilities.allowRewriteUnpublishedCommits;
  const allowedActions = ['skip', 'create-new', ...(allowRewrite && rewriteCandidates.some((item) => item.kind === 'amend') ? ['amend-head'] : []),
    ...(allowRewrite && rewriteCandidates.some((item) => item.kind === 'squash') ? ['squash-zipflow-commits'] : []), 'ask-user'];
  const gitStatus = await getGitStatus(state.project.root).catch(() => null);
  const decision = await decideAtGate(controller, {
    gate: 'result-commit', capability: 'decideResultCommit', allowedActions,
    fallback: 'ask-user', label: 'Autopilot is choosing the Git result',
    context: {
      state: {
        checksPassed: !failedChecks,
        checks: state.run.checks,
        appliedPaths: state.run.applied.paths,
        messageCandidates: candidates.map((item) => ({ id: item.id, label: item.label, message: item.message })),
        rewriteCandidates,
        gitStatus: serializeGitStatus(gitStatus),
      },
      riskLevel: failedChecks || allowedActions.length > 3 ? 'high' : 'medium',
      complete: true,
    },
    validateDecision: gitStateValidator(state.project.root, gitStatus),
  });
  const messageCandidate = candidates.find((item) => item.id === decision.targetId) ?? candidates[0];
  if (decision.action === 'skip') { await executeDecision(controller, decision, skip); return true; }
  if (decision.action === 'create-new') {
    await executeDecision(controller, decision, () => createNew(messageCandidate?.message), { messageSource: messageCandidate?.id ?? null });
    return true;
  }
  if (decision.action === 'amend-head') {
    const candidate = rewriteCandidates.find((item) => item.kind === 'amend' && (!decision.targetId || item.id === decision.targetId));
    if (!candidate) return false;
    await executeDecision(controller, decision, () => amendHead(candidate, messageCandidate?.message), { candidate: candidate.id, messageSource: messageCandidate?.id ?? null });
    return true;
  }
  if (decision.action === 'squash-zipflow-commits') {
    const candidate = rewriteCandidates.find((item) => item.kind === 'squash' && (!decision.targetId || item.id === decision.targetId));
    if (!candidate) return false;
    await executeDecision(controller, decision, () => squash(candidate, messageCandidate?.message), { candidate: candidate.id, messageSource: messageCandidate?.id ?? null });
    return true;
  }
  return false;
}

export async function decideDeployment(controller, {
  failedChecks = false,
  run,
  skip,
}) {
  const { state } = controller;
  if (!autonomyEnabledFor(state, 'decideDeployment')) return false;
  if (failedChecks && !state.workflow.autonomy.capabilities.allowDeployAfterFailedChecks) {
    await skip();
    return true;
  }
  const executionState = await captureRunExecutionState(state);
  const decision = await decideAtGate(controller, {
    gate: 'deployment', capability: 'decideDeployment', allowedActions: ['run', 'skip', 'ask-user'],
    fallback: 'skip', label: 'Autopilot is deciding deployment',
    context: {
      state: {
        checksPassed: !failedChecks,
        checks: state.run.checks,
        commit: state.run.commit,
        deployment: state.workflow.deploy,
        projectPath: state.project.root,
        executionState: executionState.value,
      },
      riskLevel: failedChecks ? 'high' : 'medium',
      complete: true,
    },
    validateDecision: runExecutionStateValidator(state, executionState),
  });
  if (decision.action === 'run') { await executeDecision(controller, decision, () => run(decision, executionState)); return true; }
  if (decision.action === 'skip') { await executeDecision(controller, decision, skip); return true; }
  return false;
}

export async function handleDeploymentFailureAutonomy(controller, {
  retry,
  finishWithError,
  rollbackLocal,
}) {
  const { state } = controller;
  if (!autonomyEnabledFor(state, 'decideDeployment')) return false;
  const retries = Number(state.run.autonomy?.deployRetries ?? 0);
  const maxRetries = Number(state.workflow.autonomy?.maxDeployRetries ?? 1);
  const allowedActions = [...(retries < maxRetries ? ['retry'] : []), 'finish-with-error',
    ...(state.workflow.autonomy.mode === 'full' ? ['rollback-local-only'] : []), 'ask-user'];
  const decision = await decideAtGate(controller, {
    gate: 'deployment-failure', capability: 'decideDeployment', allowedActions,
    fallback: 'finish-with-error', label: 'Autopilot is reviewing deployment failure',
    context: {
      state: { deployment: state.run.deploy, retries, localRollbackCannotUndoExternalEffects: true },
      riskLevel: 'high', complete: Boolean(state.run.deploy?.stdout || state.run.deploy?.stderr),
    },
  });
  if (decision.action === 'retry') {
    state.run.autonomy.deployRetries = retries + 1;
    await executeDecision(controller, decision, retry, { deployRetry: state.run.autonomy.deployRetries });
    return true;
  }
  if (decision.action === 'rollback-local-only') { await executeDecision(controller, decision, rollbackLocal); return true; }
  if (decision.action === 'finish-with-error') { await executeDecision(controller, decision, finishWithError); return true; }
  return false;
}

function serializeCheck(check) {
  if (!check) return null;
  return {
    name: check.name, required: check.required, ok: check.ok, code: check.code, signal: check.signal,
    timedOut: check.timedOut, durationMs: check.durationMs,
    stdout: String(check.stdout ?? '').slice(-20_000), stderr: String(check.stderr ?? '').slice(-20_000),
  };
}

function serializeGitStatus(status) {
  if (!status) return null;
  return { staged: status.staged, unstaged: status.unstaged, conflicted: status.conflicted };
}


async function executeDecision(controller, decision, callback, result = null) {
  try {
    await markAutonomyDecision(controller, decision, 'executing');
    const value = await callback();
    await markAutonomyDecision(controller, decision, 'executed', { result: result ?? summarizeResult(value) });
    return value;
  } catch (error) {
    await markAutonomyDecision(controller, decision, 'failed', { error }).catch(() => {});
    throw error;
  }
}

function summarizeResult(value) {
  if (value == null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return value;
  if (value?.ok !== undefined) return { ok: Boolean(value.ok) };
  return null;
}
