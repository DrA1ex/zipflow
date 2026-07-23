import { copyTextToClipboard } from 'terlio.js';
import { runChecks } from '../checks/runner.js';
import { listProjectRuns, saveRunRecord, runReportPath } from '../runs/store.js';
import { buildRunAnalytics } from '../history/analytics.js';
import { formatCompletionForClipboard, formatFailureForClipboard } from '../runs/text-report.js';
import { displayPath } from '../utils/paths.js';
import { confirmRollback, showRunDetails } from './run-rollback.js';
import { failRun } from './run-lifecycle.js';
import { explainCheckFailure } from '../llm/failure.js';
import { isLocalLlmEnabled } from '../llm/generate.js';
import { beginLlmProgress } from './llm-progress.js';
import { saveLlmDiagnostics } from '../llm/diagnostics.js';
import { activeRunSettings } from './runtime-settings.js';
import { handleFailedChecksAutonomy } from './run-autonomy.js';
import { commandLocationLabel } from '../project/command-spec.js';
import { autopilotPaused, resumeAutopilot } from './autonomy-flow.js';
import {
  activateCommitChoice, continueAfterChecks, offerCommitAfterFailedChecks,
  showCommitPrompt, submitCommitMessage,
} from './run-commit-flow.js';
import {
  activateDeployFailure, automaticRollback, continueToDeploy, showDeployPrompt,
  skipDeploymentFromPrompt, startDeploy,
} from './run-deploy-flow.js';
import { beginAnotherArchive, completeRun, showCompleted } from './run-completion.js';

export { commitMessageCandidates, commitMessageEditorInitialValue, defaultCommitMessage } from './commit-options.js';
export { finalSummaryLines, showCompleted } from './run-completion.js';

export function isPostCheckScreen(screen) {
  return [
    'checks-running', 'check-failed', 'commit', 'commit-message', 'deploy-prompt',
    'deploy-running', 'deploy-failed', 'deploy-cancelled', 'checks-cancelled', 'completed',
  ].includes(screen);
}

export async function activatePostCheck(controller, itemId) {
  const { state } = controller;
  if (state.screen === 'check-failed') return activateFailedCheck(controller, itemId);
  if (state.screen === 'commit') return activateCommitChoice(controller, itemId);
  if (state.screen === 'deploy-prompt') {
    if (itemId === 'run-deploy') return startDeploy(controller);
    if (itemId === 'skip-deploy') return skipDeploymentFromPrompt(controller);
    if (itemId === 'resume-autopilot') { await resumeAutopilot(controller); return continueToDeployFromPostcheck(controller); }
  }
  if (state.screen === 'deploy-failed' || state.screen === 'deploy-cancelled') return activateDeployFailure(controller, itemId);
  if (state.screen === 'checks-cancelled') return activateCancelledChecks(controller, itemId);
  if (state.screen === 'completed') {
    if (itemId === 'run-deploy') return startDeploy(controller, { fromCompleted: true });
    if (itemId === 'copy-summary') {
      const copied = await copyTextToClipboard(formatCompletionForClipboard(state.run), { output: controller.runtime.output });
      return copied ? controller.toast('Run summary copied', 'success') : controller.setStatus(`Report saved at ${runReportPath(state.run.id)}`);
    }
    if (itemId === 'view-report') return showRunDetails(controller, state.run, { origin: 'completed' });
    if (itemId === 'rollback') return confirmRollback(controller, state.run);
    if (itemId === 'home') return beginAnotherArchive(controller);
    if (itemId === 'project-menu') return controller.showHome();
    if (itemId === 'exit') return controller.exit(0);
  }
}

export function backPostCheck(controller) {
  if (controller.state.screen === 'commit-message') return showCommitPrompt(controller);
  if (controller.state.screen === 'deploy-prompt') return showCompleted(controller);
  if (controller.state.screen === 'completed') return controller.showHome();
  return false;
}

export async function submitPostCheckEditor(controller) {
  if (controller.state.editorContext?.purpose !== 'commit-message') return false;
  return submitCommitMessage(controller);
}

export async function startChecks(controller) {
  const { state } = controller;
  const operation = controller.beginOperation({ kind: 'checks', label: 'Running checks' });
  const checks = state.workflow.checks.filter((check) => check.selected);
  const estimate = await previousCheckEstimate(state);
  controller.message('Checks starting', [
    `${checks.length} selected check${checks.length === 1 ? '' : 's'} will run in workflow order${estimate?.totalLabel ? ` · historical median ${estimate.totalLabel}` : ''}.`,
    'Successful output stays compact; a failed command opens its useful output and copyable report.',
  ], 'process');
  state.screen = 'checks-running';
  state.checkRuntime = { checks, activeIndex: 0, results: [], lastLine: '', estimates: estimate?.byName ?? {} };
  state.status = 'Running checks';
  controller.invalidate();
  try {
    const checksResult = await runChecks({
      workflow: state.workflow,
      projectPath: state.project.root,
      changedPaths: state.run.applied.changedPaths,
      signal: operation.signal,
      onUpdate: (event) => {
        if (event.type === 'started') state.checkRuntime.activeIndex = event.index;
        if (event.type === 'output') state.checkRuntime.lastLine = lastNonEmptyLine(event.event.text);
        if (event.type === 'finished') state.checkRuntime.results = [...event.results];
        controller.invalidate();
      },
    });
    state.run.checks = checksResult;
    state.run.status = checksResult.ok ? 'checks_passed' : 'checks_failed';
    state.run = await saveRunRecord(state.run);
    if (!checksResult.ok) return operation.handoff(() => handleFailedChecks(controller, checksResult));
    controller.message('All checks passed', [`${checksResult.passed} checks passed`], 'success', {
      collapsedSummary: `Checks · ${checksResult.passed}/${checksResult.passed} passed`,
    });
    return operation.handoff(() => continueAfterChecks(controller));
  } catch (error) {
    if (error.code === 'cancelled') return showChecksCancelled(controller);
    await failRun(controller, error);
  } finally {
    operation.finish();
  }
}

async function handleFailedChecks(controller, checksResult) {
  const { state } = controller;
  const failed = checksResult.results.find((item) => !item.ok);
  controller.message('Checks failed', [
    failed?.name ?? 'Required check',
    `Directory: ${commandLocationLabel(failed?.cwd)}`,
    lastNonEmptyLine(`${failed?.stdout ?? ''}\n${failed?.stderr ?? ''}`) || 'No output',
  ], 'error', { collapsedSummary: `Checks failed · ${failed?.name ?? 'Required check'}` });
  await maybeExplainFailedCheck(controller, failed);
  controller.message('Check result summary', [checkSummaryLine(checksResult)], 'summary');
  const handled = await attemptFailedChecksAutonomy(controller, failed);
  if (handled !== false) return handled;
  return showFailedCheck(controller);
}

async function attemptFailedChecksAutonomy(controller, failed) {
  return handleFailedChecksAutonomy(controller, {
    failedCheck: failed,
    rerun: () => startChecks(controller),
    rollback: () => automaticRollback(controller),
    keepUncommitted: () => completeRun(controller, 'completed_with_errors'),
    commitAnyway: () => offerCommitAfterFailedChecks(controller, { allowDeploy: true, autonomous: true }),
  });
}

async function continueToDeployFromPostcheck(controller) {
  return continueToDeploy(controller);
}

async function showChecksCancelled(controller) {
  const { state } = controller;
  const results = state.checkRuntime?.results ?? [];
  state.run.checks = {
    results,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    skipped: Math.max(0, (state.checkRuntime?.checks?.length ?? 0) - results.length),
    ok: false,
    cancelled: true,
  };
  state.run.status = 'checks_cancelled';
  state.run = await saveRunRecord(state.run);
  controller.message('Checks cancelled', [
    'The active check process was stopped. The applied update remains available for retry, keeping, or rollback.',
  ], 'warning');
  controller.showMenu('checks-cancelled', [
    { id: 'rerun-checks', label: 'Run checks again' },
    { id: 'keep-changes', label: 'Keep changes without successful checks' },
    { id: 'rollback', label: 'Roll back update' },
  ], 'Checks cancelled');
}

function activateCancelledChecks(controller, itemId) {
  if (itemId === 'rerun-checks') return startChecks(controller);
  if (itemId === 'keep-changes') return offerCommitAfterFailedChecks(controller);
  if (itemId === 'rollback') return confirmRollback(controller, controller.state.run);
}

function showFailedCheck(controller) {
  const items = [
    ...(autopilotPaused(controller.state) ? [{ id: 'resume-autopilot', label: 'Resume autopilot', description: 'Ask the local model to decide this failed-check checkpoint again.' }] : []),
    { id: 'copy-failure', label: 'Copy failure report', description: 'Compact report for ChatGPT' },
    { id: 'view-failure', label: 'View full failed output' },
    { id: 'rerun-checks', label: 'Run checks again', description: 'Use after manually fixing files' },
    { id: 'keep-changes', label: 'Keep changes' },
    { id: 'rollback', label: 'Roll back update', description: 'Restore the exact pre-run files' },
  ];
  controller.showMenu('check-failed', items, 'Checks failed', 0, ['The update is still applied locally.', 'Fix files and re-run checks, keep the update, or restore the exact pre-run state.']);
}

async function activateFailedCheck(controller, itemId) {
  const { state } = controller;
  if (itemId === 'resume-autopilot') {
    await resumeAutopilot(controller);
    const failed = state.run.checks.results.find((item) => !item.ok);
    const handled = await attemptFailedChecksAutonomy(controller, failed);
    return handled === false ? showFailedCheck(controller) : handled;
  }
  if (itemId === 'copy-failure') {
    const copied = await copyTextToClipboard(formatFailureForClipboard(state.run), { output: controller.runtime.output });
    return copied ? controller.toast('Failure report copied', 'success') : controller.setStatus(`Report saved at ${runReportPath(state.run.id)}`);
  }
  if (itemId === 'view-failure') {
    const failed = state.run.checks.results.find((item) => !item.ok);
    controller.message(`Failed output · ${failed.name}`, [failed.stdout, failed.stderr].filter(Boolean).join('\n').split('\n'));
    return showFailedCheck(controller);
  }
  if (itemId === 'rerun-checks') return startChecks(controller);
  if (itemId === 'keep-changes') return offerCommitAfterFailedChecks(controller);
  if (itemId === 'rollback') return confirmRollback(controller, state.run);
}

async function maybeExplainFailedCheck(controller, failedCheck) {
  const { state } = controller;
  const settings = activeRunSettings(state);
  if (!failedCheck || !isLocalLlmEnabled(settings) || settings.llmFailureAnalysis === 'disabled') return null;
  const progress = beginLlmProgress(controller);
  const operation = controller.beginOperation({ kind: 'llm-failure-analysis', label: 'Explaining failed check' });
  state.llmAbortController = { abort: () => operation.abort() };
  controller.setStatus('Asking the local LLM to explain the failed check');
  const startedAt = Date.now();
  try {
    const result = await explainCheckFailure({ settings, project: state.project, run: state.run, failedCheck }, {
      onEvent: progress.onEvent, signal: operation.signal,
    });
    const record = { ...result, durationMs: Date.now() - startedAt };
    state.run.llmFailure = record;
    state.run = await saveRunRecord(state.run);
    controller.message('Local LLM error explanation', result.text.split(/\r?\n/), 'warning');
    return record;
  } catch (error) {
    const cancelled = error.code === 'cancelled';
    const diagnosticsPath = await saveLlmDiagnostics(state.run.id, {
      status: cancelled ? 'cancelled' : 'failed', provider: settings.llmProvider,
      model: settings.llmModel, stage: 'failure-analysis', ...(cancelled ? {} : { error }),
    }).catch(() => null);
    state.run.llmFailure = {
      durationMs: Date.now() - startedAt, provider: settings.llmProvider, model: settings.llmModel,
      mode: settings.llmFailureAnalysis, cancelled, error: cancelled ? null : error.message, diagnosticsPath,
    };
    state.run = await saveRunRecord(state.run);
    controller.message(cancelled ? 'LLM error explanation cancelled' : 'LLM error explanation unavailable', [
      cancelled ? 'The failed check remains available without an explanation.' : error.message,
      ...(diagnosticsPath ? [`Diagnostics: ${displayPath(diagnosticsPath)}`] : []),
    ], 'warning');
    return null;
  } finally {
    state.llmAbortController = null;
    progress.stop();
    operation.finish();
  }
}

function checkSummaryLine(checks) {
  if (!checks) return 'Checks not run';
  const total = Number(checks.passed ?? 0) + Number(checks.failed ?? 0);
  return checks.failed ? `Checks ${checks.passed}/${total} passed · ${checks.failed} failed` : `Checks ${checks.passed}/${total} passed`;
}

async function previousCheckEstimate(state) {
  const runs = (await listProjectRuns(state.project.root, { limit: 40 })).filter((run) => run.id !== state.run.id);
  const analytics = buildRunAnalytics(runs);
  if (!analytics.checks.total.count) return null;
  return {
    totalLabel: estimateLabel(analytics.checks.total.medianMs),
    byName: Object.fromEntries(analytics.checks.byName.map((item) => [item.name, item.medianMs])),
  };
}

function estimateLabel(milliseconds) {
  if (milliseconds >= 60_000) return `${Math.max(1, Math.round(milliseconds / 60_000))} min`;
  return `${Math.max(1, Math.round(milliseconds / 1000))} sec`;
}

function lastNonEmptyLine(value) {
  return String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}
