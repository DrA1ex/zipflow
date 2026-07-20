import { copyTextToClipboard } from 'terlio.js';
import { runChecks } from '../checks/runner.js';
import { runDeploy } from '../deploy/runner.js';
import { createCommit } from '../git/repository.js';
import { listProjectRuns, saveRunRecord, runReportPath } from '../runs/store.js';
import { buildRunAnalytics } from '../history/analytics.js';
import { formatCompletionForClipboard, formatFailureForClipboard } from '../runs/text-report.js';
import { saveWorkflow } from '../workflow/store.js';
import { displayPath } from '../utils/paths.js';
import { compactPlanLine, compactPlanMeta, formatArchiveName } from '../ui/format.js';
import { confirmRollback, showRunDetails } from './run-rollback.js';
import { failRun, releaseRunResources } from './run-lifecycle.js';
import { finalizeSourceArchive } from './archive-policy.js';
import { explainCheckFailure } from '../llm/failure.js';
import { isLocalLlmEnabled } from '../llm/generate.js';
import { beginLlmProgress } from './llm-progress.js';
import { saveLlmDiagnostics } from '../llm/diagnostics.js';
import { activeRunSettings, clearRunSettings } from './runtime-settings.js';
import { waitForPendingLlmReview } from './run-llm-review.js';
import { recentArchiveHint } from '../settings/recent.js';

export function isPostCheckScreen(screen) {
  return [
    'checks-running', 'check-failed', 'commit', 'commit-message', 'deploy-prompt',
    'deploy-running', 'deploy-failed', 'completed',
  ].includes(screen);
}

export async function activatePostCheck(controller, itemId) {
  const { state } = controller;
  if (state.screen === 'check-failed') return activateFailedCheck(controller, itemId);
  if (state.screen === 'commit') {
    if (itemId === 'create-commit') return createResultCommit(controller, defaultCommitMessage(state));
    if (itemId === 'edit-message') return controller.showEditor('commit-message', {
      label: 'Commit message',
      purpose: 'commit-message',
      placeholder: defaultCommitMessage(state),
      multiline: true,
      instructions: commitMessageInstructions(state),
    }, commitMessageEditorInitialValue(state));
    if (itemId === 'finish-no-commit') return continueAfterCommitChoice(controller);
  }
  if (state.screen === 'deploy-prompt') {
    if (itemId === 'run-deploy') return startDeploy(controller);
    if (itemId === 'skip-deploy') {
      state.run.deploy = { skipped: true, policy: state.workflow.deploy.policy, commandText: state.workflow.deploy.commandText };
      return completeRun(controller, 'completed');
    }
  }
  if (state.screen === 'deploy-failed') return activateDeployFailed(controller, itemId);
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
  if (controller.state.screen === 'deploy-prompt') return showCommitOrComplete(controller);
  if (controller.state.screen === 'completed') return controller.showHome();
  return false;
}

export async function submitPostCheckEditor(controller) {
  if (controller.state.editorContext?.purpose !== 'commit-message') return false;
  const message = controller.state.editor.value.trim();
  if (!message) return controller.setStatus('Enter a commit message.');
  await createResultCommit(controller, message);
  return true;
}

export async function startChecks(controller) {
  const { state } = controller;
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
    if (!checksResult.ok) {
      const failed = checksResult.results.find((item) => !item.ok);
      controller.message('Checks failed', [
        failed?.name ?? 'Required check',
        lastNonEmptyLine(`${failed?.stdout ?? ''}\n${failed?.stderr ?? ''}`) || 'No output',
      ], 'error', { collapsedSummary: `Checks failed · ${failed?.name ?? 'Required check'}` });
      await maybeExplainFailedCheck(controller, failed);
      controller.message('Check result summary', [checkSummaryLine(checksResult)], 'summary');
      return showFailedCheck(controller);
    }
    controller.message('All checks passed', [`${checksResult.passed} checks passed`], 'success', { collapsedSummary: `Checks · ${checksResult.passed}/${checksResult.passed} passed` });
    return continueAfterChecks(controller);
  } catch (error) {
    await failRun(controller, error);
  }
}

async function continueAfterChecks(controller) {
  await waitForPendingLlmReview(controller);
  const { state } = controller;
  if (!state.run.applied.paths.length || state.workflow.git.resultCommit === 'never') return continueToDeploy(controller);
  if (state.workflow.git.resultCommit === 'auto') return createResultCommit(controller, defaultCommitMessage(state));
  return showCommitPrompt(controller);
}

function showFailedCheck(controller) {
  controller.showMenu('check-failed', [
    { id: 'copy-failure', label: 'Copy failure report', description: 'Compact report for ChatGPT' },
    { id: 'view-failure', label: 'View full failed output' },
    { id: 'rerun-checks', label: 'Run checks again', description: 'Use after manually fixing files' },
    { id: 'keep-changes', label: 'Keep changes' },
    { id: 'rollback', label: 'Roll back update', description: 'Restore the exact pre-run files' },
  ], 'Checks failed', 0, ['The update is still applied locally.', 'Fix files and re-run checks, keep the update, or restore the exact pre-run state.']);
}

async function activateFailedCheck(controller, itemId) {
  const { state } = controller;
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

function showCommitPrompt(controller) {
  const message = defaultCommitMessage(controller.state);
  const failedChecks = controller.state.postCheckContinuation?.status === 'completed_with_errors';
  controller.showMenu('commit', [
    { id: 'create-commit', label: 'Create commit', description: message },
    { id: 'edit-message', label: 'Edit message', description: commitMessageSource(controller.state) },
    {
      id: 'finish-no-commit', label: 'Continue without commit',
      description: failedChecks ? 'Keep the update without a commit; deployment remains skipped' : 'Deployment settings still apply after this step',
    },
  ], failedChecks ? 'Commit kept changes' : 'Commit result', 0, [
    `Proposed source: ${commitMessageSource(controller.state)}`,
    'The commit includes only paths applied by this Zipflow run.',
    ...(controller.state.postCheckContinuation?.status === 'completed_with_errors'
      ? ['Required checks failed; this commit records the kept state without running deployment.'] : []),
  ]);
}

async function createResultCommit(controller, message) {
  const { state } = controller;
  const result = await createCommit(state.project.root, state.run.applied.paths, message);
  if (!result.ok) {
    controller.message('Commit was not created', [result.reason], 'error');
    return showCommitPrompt(controller);
  }
  state.run.commit = { revision: result.revision, message };
  state.run = await saveRunRecord(state.run);
  controller.message('Commit created', [`${result.revision} ${firstLine(message)}`], 'success');
  return continueAfterCommitChoice(controller);
}

function continueAfterCommitChoice(controller) {
  const continuation = controller.state.postCheckContinuation;
  if (continuation?.skipDeploy) {
    controller.state.postCheckContinuation = null;
    return completeRun(controller, continuation.status);
  }
  controller.state.postCheckContinuation = null;
  return continueToDeploy(controller);
}

function offerCommitAfterFailedChecks(controller) {
  const { state } = controller;
  if (!state.run.applied.paths.length || state.workflow.git.resultCommit === 'never') {
    return completeRun(controller, 'completed_with_errors');
  }
  state.postCheckContinuation = { status: 'completed_with_errors', skipDeploy: true };
  controller.message('Keeping changes after failed checks', [
    'The update will remain applied. You can still create a commit that records this exact state.',
    'Deployment will not run because required checks failed.',
  ], 'warning');
  return showCommitPrompt(controller);
}

function continueToDeploy(controller) {
  const policy = controller.state.workflow.deploy?.policy ?? 'disabled';
  if (policy === 'always') return startDeploy(controller);
  if (policy === 'ask') return showDeployPrompt(controller);
  return completeRun(controller, 'completed');
}

function showDeployPrompt(controller) {
  const deploy = controller.state.workflow.deploy;
  controller.showMenu('deploy-prompt', [
    { id: 'run-deploy', label: 'Run deployment', description: deploy.commandText },
    { id: 'skip-deploy', label: 'Finish without deployment', description: 'The update and successful checks remain recorded' },
  ], 'Checks passed · deployment is ready', 0, ['Every required check passed.', 'Deployment is optional for this run and does not change the recorded local update.']);
}

async function startDeploy(controller, { fromCompleted = false } = {}) {
  const { state } = controller;
  const deploy = state.workflow.deploy;
  state.screen = 'deploy-running';
  state.deployRuntime = { commandText: deploy.commandText, lastLine: '', fromCompleted };
  state.status = 'Deploying';
  controller.invalidate();
  try {
    const result = await runDeploy({
      deploy,
      projectPath: state.project.root,
      onOutput: (event) => {
        state.deployRuntime.lastLine = lastNonEmptyLine(event.text);
        controller.invalidate();
      },
    });
    state.run.deploy = { ...result, policy: deploy.policy, commandText: deploy.commandText, cwd: deploy.cwd || '.' };
    state.run = await saveRunRecord(state.run);
    if (!result.ok) {
      controller.message('Deployment failed', [
        deploy.commandText,
        lastNonEmptyLine(`${result.stdout}\n${result.stderr}`) || 'No output',
      ], 'error', { collapsedSummary: `Deployment · failed · ${deploy.commandText}` });
      return showDeployFailed(controller);
    }
    controller.message('Deployment completed', [deploy.commandText], 'success', { collapsedSummary: `Deployment · completed · ${deploy.commandText}` });
    if (fromCompleted) return showCompleted(controller);
    return completeRun(controller, 'completed');
  } catch (error) {
    await failRun(controller, error);
  }
}

function showDeployFailed(controller) {
  controller.showMenu('deploy-failed', [
    { id: 'view-deploy-output', label: 'View full deployment output' },
    { id: 'retry-deploy', label: 'Run deployment again' },
    { id: 'finish-deploy-error', label: 'Finish and keep the update', description: 'Record the deployment failure without rolling back local files' },
    { id: 'rollback', label: 'Roll back local update', description: 'External deployment effects cannot be undone by Zipflow' },
  ], 'Deployment failed');
}

function activateDeployFailed(controller, itemId) {
  const { state } = controller;
  if (itemId === 'view-deploy-output') {
    controller.message('Deployment output', [state.run.deploy.stdout, state.run.deploy.stderr].filter(Boolean).join('\n').split('\n'));
    return showDeployFailed(controller);
  }
  if (itemId === 'retry-deploy') return startDeploy(controller);
  if (itemId === 'finish-deploy-error') return completeRun(controller, 'completed_with_errors');
  if (itemId === 'rollback') return confirmRollback(controller, state.run);
}

async function completeRun(controller, status) {
  const { state } = controller;
  state.run.status = status;
  state.run = await saveRunRecord(state.run);
  state.workflow.lastRunId = state.run.id;
  state.workflow = await saveWorkflow(state.workflow);
  await finalizeSourceArchive(controller);
  await releaseRunResources(controller);
  controller.message('Final summary', finalSummaryLines(state), 'summary', { collapsedSummary: `Run complete · ${compactPlanLine(state.plan)} · ${checkSummaryLine(state.run.checks)}` });
  clearRunSettings(state);
  showCompleted(controller);
}


async function maybeExplainFailedCheck(controller, failedCheck) {
  const { state } = controller;
  const settings = activeRunSettings(state);
  if (!failedCheck || !isLocalLlmEnabled(settings) || settings.llmFailureAnalysis === 'disabled') return null;
  const progress = beginLlmProgress(controller);
  const abortController = new AbortController();
  state.llmAbortController = abortController;
  controller.setStatus('Asking the local LLM to explain the failed check');
  const startedAt = Date.now();
  try {
    const result = await explainCheckFailure({
      settings, project: state.project, run: state.run, failedCheck,
    }, { onEvent: progress.onEvent, signal: abortController.signal });
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
      durationMs: Date.now() - startedAt,
      provider: settings.llmProvider, model: settings.llmModel,
      mode: settings.llmFailureAnalysis,
      cancelled, error: cancelled ? null : error.message, diagnosticsPath,
    };
    state.run = await saveRunRecord(state.run);
    controller.message(cancelled ? 'LLM error explanation cancelled' : 'LLM error explanation unavailable', [
      cancelled ? 'The failed check remains available without an explanation.' : error.message,
      ...(diagnosticsPath ? [`Diagnostics: ${displayPath(diagnosticsPath)}`] : []),
    ], 'warning');
    return null;
  } finally {
    if (state.llmAbortController === abortController) state.llmAbortController = null;
    progress.stop();
  }
}

export function finalSummaryLines(state) {
  const lines = [];
  if (state.run.llm?.summary?.length) lines.push(...state.run.llm.summary);
  lines.push(
    `${compactPlanLine(state.plan)} · ${checkSummaryLine(state.run.checks)} · Deployment ${deploymentResultLine(state)} · Source archive ${archiveDispositionLine(state.run.archiveDisposition)}`,
    `Commit ${state.run.commit ? `${state.run.commit.revision} ${firstLine(state.run.commit.message)}` : 'not created'} · Report ${displayPath(runReportPath(state.run.id))}`,
  );
  return lines;
}

function checkSummaryLine(checks) {
  if (!checks) return 'Checks not run';
  const total = Number(checks.passed ?? 0) + Number(checks.failed ?? 0);
  return checks.failed
    ? `Checks ${checks.passed}/${total} passed · ${checks.failed} failed`
    : `Checks ${checks.passed}/${total} passed`;
}

export function showCompleted(controller) {
  const { state } = controller;
  const items = [
    { id: 'home', label: 'Finish and wait for next archive', description: 'Keep Zipflow ready for the next ZIP; Esc returns to the project menu' },
    { id: 'copy-summary', label: 'Copy run summary', description: 'Copy a compact summary with changes, checks, commit, and deployment' },
    { id: 'view-report', label: 'View run details', description: 'Open the stored decisions, checks, commit, deployment, and report path' },
  ];
  if (state.workflow.deploy?.policy === 'on-demand' && !state.run.deploy?.ok) {
    items.push({ id: 'run-deploy', label: 'Run deployment', description: state.workflow.deploy.commandText });
  }
  if (!state.run.rollback || state.run.rollback.status !== 'completed') {
    items.push({ id: 'rollback', label: 'Roll back this update', description: 'Restore the exact local state from before this run' });
  }
  items.push({ id: 'project-menu', label: 'Return to project menu' });
  items.push({ id: 'exit', label: 'Exit' });
  controller.showMenu('completed', items, 'Run completed', 0);
}

function showCommitOrComplete(controller) {
  if (controller.state.workflow.git.resultCommit === 'ask' && controller.state.run.applied.paths.length && !controller.state.run.commit) {
    return showCommitPrompt(controller);
  }
  return completeRun(controller, 'completed');
}

function beginAnotherArchive(controller) {
  controller.showEditor('archive-input', {
    label: 'ZIP archive path',
    placeholder: '~/Downloads/project-update.zip',
    purpose: 'archive-path',
    instructions: [
      'Drop a ZIP file into the terminal or enter its path. Tab completes ZIP paths.',
      ...(recentArchiveHint(controller.state.settings) ? [recentArchiveHint(controller.state.settings)] : []),
    ],
  }, '');
  controller.setStatus('Waiting for archive');
}

export function defaultCommitMessage(state) {
  const strategy = state.workflow.git.messageStrategy;
  const llmMessage = cleanCommitMessage(state.run.llm?.commitMessage);
  const metadataMessage = cleanCommitMessage(state.archiveMetadata?.commitMessage);
  if (strategy === 'llm' && llmMessage) return llmMessage;
  if (strategy === 'llm' && metadataMessage) return metadataMessage;
  if (strategy === 'metadata' && metadataMessage) return metadataMessage;
  if (strategy === 'archive') return `Apply ${formatArchiveName(state.run.archivePath)}`;
  if (strategy === 'fixed') return cleanCommitMessage(renderTemplate(state.workflow.git.fixedMessage, state)) || `zipflow: apply ${state.run.id}`;
  return `zipflow: apply ${state.run.id}`;
}

export function commitMessageEditorInitialValue(state) {
  if (state.workflow.git.messageStrategy === 'llm' && !cleanCommitMessage(state.run.llm?.commitMessage)) return '';
  return defaultCommitMessage(state);
}

function cleanCommitMessage(value) {
  if (typeof value !== 'string') return '';
  const message = value.trim();
  if (!message) return '';
  if (/^[\[{]/.test(message)) {
    try {
      JSON.parse(message);
      return '';
    } catch {
      // A normal commit message may legitimately begin with a bracket.
    }
  }
  return message;
}

function renderTemplate(template, state) {
  const now = new Date();
  return String(template)
    .replaceAll('{runId}', state.run.id)
    .replaceAll('{archiveName}', formatArchiveName(state.run.archivePath))
    .replaceAll('{projectName}', state.project.name)
    .replaceAll('{date}', now.toISOString().slice(0, 10))
    .replaceAll('{time}', now.toTimeString().slice(0, 8));
}

function commitMessageSource(state) {
  if (state.workflow.git.messageStrategy === 'llm') {
    if (state.run.llm?.commitMessage) return `Generated by ${state.run.llm.provider} · ${state.run.llm.model}`;
    if (state.run.llm?.error) return `Local LLM failed: ${state.run.llm.error}; using the configured fallback`;
    return 'Local LLM is not configured; using archive metadata or the run identifier';
  }
  if (state.workflow.git.messageStrategy === 'metadata') {
    return state.archiveMetadata?.commitMessageSource
      ? `Read from ${state.archiveMetadata.commitMessageSource}`
      : 'No archive message file found; generated run identifier is used';
  }
  return 'Change the proposed message for this run only';
}

function commitMessageInstructions(state) {
  const source = commitMessageSource(state);
  return [source, 'The complete text, including additional lines, is passed to Git as the commit message.'];
}

function deploymentResultLine(state) {
  if (!state.run.deploy) return state.workflow.deploy?.policy === 'on-demand' ? 'available on demand' : 'not run';
  if (state.run.deploy.skipped) return 'skipped';
  return state.run.deploy.ok ? 'passed' : 'failed';
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

function archiveDispositionLine(value) {
  if (!value) return 'not processed';
  if (value.action === 'moved') return `moved to ${displayPath(value.path)}`;
  if (value.action === 'deleted') return 'deleted by global policy';
  if (value.action === 'kept') return 'kept in original location';
  return value.error ? `policy failed: ${value.error}` : value.action;
}

function lastNonEmptyLine(value) {
  return String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

function firstLine(value) {
  return String(value).split('\n')[0];
}
