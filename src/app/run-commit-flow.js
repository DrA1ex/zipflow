import { amendZipflowCommit, createCommit, getCommitRewriteCandidates, squashZipflowCommits } from '../git/repository.js';
import { listProjectRuns, saveRunRecord } from '../runs/store.js';
import { commitMessageCandidates, commitMessageEditorInitialValue, defaultCommitMessage } from './commit-options.js';
import { decideResultCommit } from './run-autonomy.js';
import { continueToDeploy } from './run-deploy-flow.js';
import { completeRun } from './run-completion.js';
import { waitForPendingLlmReview } from './run-llm-review.js';
import { autopilotPaused, resumeAutopilot } from './autonomy-flow.js';

export { commitMessageCandidates, commitMessageEditorInitialValue, defaultCommitMessage } from './commit-options.js';

export async function continueAfterChecks(controller) {
  await waitForPendingLlmReview(controller);
  return decideCommitOrPrompt(controller, { failedChecks: false });
}

async function decideCommitOrPrompt(controller, { failedChecks }) {
  const { state } = controller;
  if (!state.run.applied.paths.length || state.workflow.git.resultCommit === 'never') return continueToDeploy(controller);
  const candidates = commitMessageCandidates(state);
  const previousRuns = await listProjectRuns(state.project.root, { limit: 20 });
  const rewriteCandidates = await getCommitRewriteCandidates(state.project.root, previousRuns.filter((run) => run.id !== state.run.id), { currentPaths: state.run.applied.paths });
  const handled = await decideResultCommit(controller, {
    failedChecks, candidates, rewriteCandidates,
    createNew: (message) => createResultCommit(controller, message || defaultCommitMessage(state)),
    amendHead: (candidate, message) => rewriteResultCommit(controller, 'amend', candidate, message || defaultCommitMessage(state)),
    squash: (candidate, message) => rewriteResultCommit(controller, 'squash', candidate, message || defaultCommitMessage(state)),
    skip: () => continueAfterCommitChoice(controller),
  });
  if (handled !== false) return handled;
  if (!failedChecks && state.workflow.git.resultCommit === 'auto') return createResultCommit(controller, defaultCommitMessage(state));
  return showCommitPrompt(controller);
}

export function showCommitPrompt(controller) {
  const state = controller.state;
  const failedChecks = state.postCheckContinuation?.status === 'completed_with_errors';
  const candidates = commitMessageCandidates(state);
  const items = [
    ...(autopilotPaused(state) ? [{ id: 'resume-autopilot', label: 'Resume autopilot', description: 'Ask the local model to choose the Git result again.' }] : []),
    ...candidates.map((candidate, index) => ({
    id: index === 0 ? 'create-commit' : `create-commit:${candidate.id}`,
    label: `Create commit · ${candidate.label}`,
    description: candidate.message,
    help: candidate.detail,
  })),
  ];
  items.push({
    id: 'edit-message', label: 'Edit message…', description: candidates[0]?.message || 'Enter a custom commit message.',
  }, {
    id: 'finish-no-commit', label: 'Continue without commit',
    description: failedChecks ? 'Keep the update without a commit.' : 'Continue to the configured deployment step.',
  });
  controller.showMenu('commit', items, failedChecks ? 'Commit kept changes' : 'Commit result', 0,
    failedChecks ? ['Required checks failed. The run will remain completed with errors.'] : []);
}

export async function activateCommitChoice(controller, itemId) {
  const { state } = controller;
  if (itemId === 'resume-autopilot') {
    await resumeAutopilot(controller);
    return continueAfterChecks(controller);
  }
  if (itemId === 'create-commit') {
    const candidate = commitMessageCandidates(state)[0];
    if (candidate) return createResultCommit(controller, candidate.message);
  }
  if (itemId.startsWith('create-commit:')) {
    const candidate = commitMessageCandidates(state).find((item) => item.id === itemId.slice('create-commit:'.length));
    if (candidate) return createResultCommit(controller, candidate.message);
  }
  if (itemId === 'edit-message') return controller.showEditor('commit-message', {
    label: 'Commit message', purpose: 'commit-message', placeholder: 'Enter a commit message…', multiline: true,
    context: 'Edit the preferred proposal, then press Enter to create the commit.',
  }, commitMessageEditorInitialValue(state));
  if (itemId === 'finish-no-commit') return continueAfterCommitChoice(controller);
  return false;
}

export async function submitCommitMessage(controller) {
  const message = controller.state.editor.value.trim();
  if (!message) return controller.setStatus('Enter a commit message.');
  await createResultCommit(controller, message);
  return true;
}

export async function createResultCommit(controller, message) {
  const { state } = controller;
  const operation = controller.beginOperation({ kind: 'git-commit', label: 'Creating Git commit', critical: true });
  try {
    const result = await createCommit(state.project.root, state.run.applied.paths, message, { signal: operation.signal });
    if (!result.ok) {
      controller.message('Commit was not created', [result.reason], 'error');
      return showCommitPrompt(controller);
    }
    state.run.commit = { revision: result.revision, message, strategy: 'create-new' };
    state.run = await saveRunRecord(state.run);
    controller.message('Commit created', [`${result.revision} ${firstLine(message)}`], 'success');
    if (operation.isCancellationRequested()) {
      controller.message('Cancellation completed after Git commit', ['The atomic commit was allowed to finish. Deployment was skipped.'], 'warning');
      state.postCheckContinuation = null;
      return operation.handoff(() => completeRun(controller, completionStatus(state)));
    }
    return operation.handoff(() => continueAfterCommitChoice(controller));
  } catch (error) {
    if (error.code === 'cancelled') {
      controller.message('Commit cancelled', ['No result commit was recorded. Check the Git status before retrying.'], 'warning');
      return showCommitPrompt(controller);
    }
    throw error;
  } finally {
    operation.finish();
  }
}

export async function rewriteResultCommit(controller, kind, candidate, message) {
  const { state } = controller;
  const operation = controller.beginOperation({ kind: 'git-rewrite', label: kind === 'amend' ? 'Amending Git commit' : 'Squashing Git commits', critical: true });
  try {
    const result = kind === 'amend'
      ? await amendZipflowCommit(state.project.root, { runId: state.run.id, paths: state.run.applied.paths, message, candidate, signal: operation.signal })
      : await squashZipflowCommits(state.project.root, { runId: state.run.id, paths: state.run.applied.paths, message, candidate, signal: operation.signal });
    if (!result.ok) {
      controller.message('Commit rewrite was not created', [result.reason], 'error');
      return showCommitPrompt(controller);
    }
    state.run.commit = {
      revision: result.revision, message, strategy: kind,
      backupRef: result.backupRef, rewrittenRunIds: result.rewrittenRunIds,
    };
    state.run = await saveRunRecord(state.run);
    controller.message(kind === 'amend' ? 'Commit amended' : 'Zipflow commits squashed', [
      `${result.revision} ${firstLine(message)}`, `Recovery ref: ${result.backupRef}`,
    ], 'success');
    if (operation.isCancellationRequested()) {
      controller.message('Cancellation completed after Git rewrite', ['The atomic rewrite was allowed to finish. Deployment was skipped.'], 'warning');
      state.postCheckContinuation = null;
      return operation.handoff(() => completeRun(controller, completionStatus(state)));
    }
    return operation.handoff(() => continueAfterCommitChoice(controller));
  } catch (error) {
    if (error.code === 'cancelled') {
      controller.message('Commit rewrite cancelled', ['The rewrite backup ref remains available if Git changed before cancellation.'], 'warning');
      return showCommitPrompt(controller);
    }
    throw error;
  } finally {
    operation.finish();
  }
}

export async function offerCommitAfterFailedChecks(controller, { allowDeploy = false, autonomous = false } = {}) {
  const { state } = controller;
  if (!state.run.applied.paths.length || state.workflow.git.resultCommit === 'never') {
    return completeRun(controller, 'completed_with_errors');
  }
  state.postCheckContinuation = { status: 'completed_with_errors', skipDeploy: !allowDeploy, failedChecks: true };
  controller.message('Keeping changes after failed checks', [
    'The update will remain applied. A commit, if created, records a run whose required checks failed.',
    allowDeploy ? 'Full autopilot may still decide whether configured deployment should run.' : 'Deployment will not run because required checks failed.',
  ], 'warning');
  return autonomous ? decideCommitOrPrompt(controller, { failedChecks: true }) : showCommitPrompt(controller);
}

export function continueAfterCommitChoice(controller) {
  const continuation = controller.state.postCheckContinuation;
  if (continuation?.skipDeploy) {
    controller.state.postCheckContinuation = null;
    return completeRun(controller, continuation.status);
  }
  controller.state.postCheckContinuation = null;
  return continueToDeploy(controller);
}

function completionStatus(state) {
  return state.run.checks?.failed || state.postCheckContinuation?.failedChecks ? 'completed_with_errors' : 'completed';
}

function firstLine(value) {
  return String(value).split('\n')[0];
}
