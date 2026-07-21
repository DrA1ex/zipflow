import { readFile } from 'node:fs/promises';
import { runChecks } from '../checks/runner.js';
import { runDeploy } from '../deploy/runner.js';
import { collectExportPaths } from '../export/candidates.js';
import { explainCheckFailure } from '../llm/failure.js';
import { isLocalLlmEnabled } from '../llm/generate.js';
import { saveLlmDiagnostics } from '../llm/diagnostics.js';
import { createRunId } from '../utils/id.js';
import { displayPath } from '../utils/paths.js';
import { createActionRunRecord, runReportPath, saveRunRecord } from '../runs/store.js';
import { beginLlmProgress } from './llm-progress.js';

export function handlesManualScreen(screen) {
  return ['manual-checks-running', 'manual-checks-result', 'manual-deploy-running', 'manual-deploy-result'].includes(screen);
}

export async function beginManualChecks(controller) {
  const { state } = controller;
  const checks = state.workflow.checks.filter((check) => check.selected);
  if (!checks.length) return controller.message('No checks configured', ['Change the workflow to select at least one check.'], 'warning');
  const operation = controller.beginOperation({ kind: 'manual-checks', label: 'Running manual checks' });
  const run = await createActionRunRecord({ id: createRunId(), project: state.project, workflow: state.workflow, action: 'manual-checks' });
  state.run = run;
  state.screen = 'manual-checks-running';
  state.status = 'Running tests';
  state.checkRuntime = { checks, activeIndex: 0, results: [], lastLine: '', estimates: {} };
  controller.message('Manual checks starting', [`${checks.length} configured check${checks.length === 1 ? '' : 's'} will run against the current project files.`], 'process');
  controller.invalidate();
  try {
    const changedPaths = await collectExportPaths({ project: state.project, mode: 'nonignored', signal: operation.signal });
    const result = await runChecks({
      workflow: state.workflow,
      projectPath: state.project.root,
      changedPaths,
      signal: operation.signal,
      onUpdate: (event) => updateCheckRuntime(controller, event),
    });
    run.checks = result;
    run.status = result.ok ? 'completed' : 'completed_with_errors';
    state.run = await saveRunRecord(run);
    controller.message(result.ok ? 'Manual checks passed' : 'Manual checks failed', [
      `${result.passed} passed · ${result.failed} failed · ${result.skipped} skipped`,
      `Report: ${displayPath(runReportPath(run.id))}`,
    ], result.ok ? 'success' : 'error');
    return showManualChecksResult(controller);
  } catch (error) {
    const cancelled = error.code === 'cancelled';
    run.status = cancelled ? 'cancelled' : 'failed';
    run.error = cancelled ? null : { message: error.message };
    run.checks ??= { results: state.checkRuntime?.results ?? [], ok: false, cancelled };
    state.run = await saveRunRecord(run);
    controller.message(cancelled ? 'Manual checks cancelled' : 'Manual checks could not run', [
      cancelled ? 'The active check process was stopped. Zipflow remains open.' : error.message,
      `Report: ${displayPath(runReportPath(run.id))}`,
    ], cancelled ? 'warning' : 'error');
    return showManualChecksResult(controller);
  } finally {
    operation.finish();
  }
}

export async function beginManualDeploy(controller) {
  const { state } = controller;
  if (!state.workflow.deploy?.commandText) return controller.message('Deployment is not configured', ['Change the workflow to choose a deploy command.'], 'warning');
  const operation = controller.beginOperation({ kind: 'manual-deploy', label: 'Running manual deployment' });
  const run = await createActionRunRecord({ id: createRunId(), project: state.project, workflow: state.workflow, action: 'manual-deploy' });
  state.run = run;
  state.screen = 'manual-deploy-running';
  state.status = 'Deploying current version';
  state.deployRuntime = { commandText: state.workflow.deploy.commandText, lastLine: '' };
  controller.message('Manual deployment starting', [state.workflow.deploy.commandText, 'This deploys the current local project without applying a ZIP archive.'], 'process');
  controller.invalidate();
  try {
    const result = await runDeploy({
      deploy: state.workflow.deploy,
      projectPath: state.project.root,
      signal: operation.signal,
      onOutput: (event) => {
        state.deployRuntime.lastLine = lastNonEmptyLine(event.text);
        controller.invalidate();
      },
    });
    run.deploy = { ...result, policy: 'manual', commandText: state.workflow.deploy.commandText, cwd: state.workflow.deploy.cwd || '.' };
    run.status = result.ok ? 'completed' : 'completed_with_errors';
    state.run = await saveRunRecord(run);
    controller.message(result.ok ? 'Manual deployment completed' : 'Manual deployment failed', [
      state.workflow.deploy.commandText,
      `Report: ${displayPath(runReportPath(run.id))}`,
    ], result.ok ? 'success' : 'error');
    return showManualDeployResult(controller);
  } catch (error) {
    const cancelled = error.code === 'cancelled';
    run.status = cancelled ? 'cancelled' : 'failed';
    run.error = cancelled ? null : { message: error.message };
    run.deploy ??= { ok: false, cancelled, commandText: state.workflow.deploy.commandText };
    state.run = await saveRunRecord(run);
    controller.message(cancelled ? 'Manual deployment cancelled' : 'Manual deployment could not run', [
      cancelled ? 'The deployment process was stopped. External effects may already exist.' : error.message,
      `Report: ${displayPath(runReportPath(run.id))}`,
    ], cancelled ? 'warning' : 'error');
    return showManualDeployResult(controller);
  } finally {
    operation.finish();
  }
}

export async function activateManual(controller, itemId) {
  if (itemId === 'manual-checks-again') return beginManualChecks(controller);
  if (itemId === 'manual-deploy-again') return beginManualDeploy(controller);
  if (itemId === 'manual-home') return controller.showHome();
  if (itemId === 'manual-report') return showStoredReport(controller);
  if (itemId === 'manual-output') return showFailedOutput(controller);
  if (itemId === 'manual-explain') return explainManualFailure(controller);
}

export function backManual(controller) {
  if (['manual-checks-result', 'manual-deploy-result'].includes(controller.state.screen)) return controller.showHome();
  return false;
}

function showManualChecksResult(controller) {
  const failed = controller.state.run.checks?.results?.find((item) => !item.ok);
  const items = [];
  if (failed) items.push({ id: 'manual-output', label: 'View failed output', description: failed.name });
  if (failed && canExplain(controller.state)) items.push({ id: 'manual-explain', label: 'Explain error with local LLM', description: 'Run only when selected; the automatic update workflow is unchanged' });
  items.push({ id: 'manual-report', label: 'View report', description: displayPath(runReportPath(controller.state.run.id)) });
  items.push({ id: 'manual-checks-again', label: 'Run tests again' });
  items.push({ id: 'manual-home', label: 'Return to project' });
  controller.showMenu('manual-checks-result', items, failed ? 'Manual checks failed' : 'Manual checks passed', 0);
}

function showManualDeployResult(controller) {
  const failed = controller.state.run.deploy && !controller.state.run.deploy.ok;
  const items = [];
  if (failed) items.push({ id: 'manual-output', label: 'View failed output', description: controller.state.run.deploy.commandText });
  if (failed && canExplain(controller.state)) items.push({ id: 'manual-explain', label: 'Explain error with local LLM', description: 'Run only when selected; deployment is not retried automatically' });
  items.push({ id: 'manual-report', label: 'View report', description: displayPath(runReportPath(controller.state.run.id)) });
  items.push({ id: 'manual-deploy-again', label: 'Run deployment again' });
  items.push({ id: 'manual-home', label: 'Return to project' });
  controller.showMenu('manual-deploy-result', items, failed ? 'Manual deployment failed' : 'Manual deployment completed', 0);
}

async function showStoredReport(controller) {
  const reportPath = runReportPath(controller.state.run.id);
  const text = await readFile(reportPath, 'utf8').catch(() => 'The stored report could not be read.');
  controller.message('Manual run report', text.trimEnd().split(/\r?\n/));
  return restoreResultScreen(controller);
}

function showFailedOutput(controller) {
  const failedCheck = controller.state.run.checks?.results?.find((item) => !item.ok);
  const result = failedCheck ?? controller.state.run.deploy;
  const output = [result?.stdout, result?.stderr].filter(Boolean).join('\n').trim() || '(no output)';
  controller.message('Failed command output', output.split(/\r?\n/), 'error');
  return restoreResultScreen(controller);
}

async function explainManualFailure(controller) {
  const { state } = controller;
  const failedCheck = state.run.checks?.results?.find((item) => !item.ok) ?? deployAsCheck(state.run.deploy);
  if (!failedCheck) return restoreResultScreen(controller);
  const progress = beginLlmProgress(controller);
  const operation = controller.beginOperation({ kind: 'llm-failure-analysis', label: 'Explaining manual failure' });
  state.llmAbortController = { abort: () => operation.abort() };
  controller.setStatus('Asking the local LLM to explain the error');
  const startedAt = Date.now();
  try {
    const result = await explainCheckFailure({ settings: state.settings, project: state.project, run: state.run, failedCheck }, {
      onEvent: progress.onEvent, signal: operation.signal,
    });
    state.run.llmFailure = { ...result, durationMs: Date.now() - startedAt };
    state.run = await saveRunRecord(state.run);
    controller.message('Local LLM error explanation', result.text.split(/\r?\n/), 'warning');
  } catch (error) {
    const cancelled = error.code === 'cancelled';
    const diagnosticsPath = await saveLlmDiagnostics(state.run.id, {
      status: cancelled ? 'cancelled' : 'failed', stage: 'manual-failure-analysis',
      provider: state.settings.llmProvider, model: state.settings.llmModel,
      ...(cancelled ? {} : { error }),
    }).catch(() => null);
    state.run.llmFailure = {
      durationMs: Date.now() - startedAt, cancelled, error: cancelled ? null : error.message,
      provider: state.settings.llmProvider, model: state.settings.llmModel, diagnosticsPath,
    };
    state.run = await saveRunRecord(state.run);
    controller.message(cancelled ? 'LLM explanation cancelled' : 'LLM explanation unavailable', [
      cancelled ? 'The manual run report remains available without an explanation.' : error.message,
    ], 'warning');
  } finally {
    state.llmAbortController = null;
    progress.stop();
    operation.finish();
  }
  return restoreResultScreen(controller);
}

function restoreResultScreen(controller) {
  return controller.state.run.kind === 'manual-deploy' ? showManualDeployResult(controller) : showManualChecksResult(controller);
}

function updateCheckRuntime(controller, event) {
  const runtime = controller.state.checkRuntime;
  if (event.type === 'started') runtime.activeIndex = event.index;
  if (event.type === 'output') runtime.lastLine = lastNonEmptyLine(event.event.text);
  if (event.type === 'finished') runtime.results = [...event.results];
  controller.invalidate();
}

function canExplain(state) {
  return isLocalLlmEnabled(state.settings) && state.settings.llmFailureAnalysis !== 'disabled';
}

function deployAsCheck(result) {
  if (!result || result.ok) return null;
  return { ...result, name: 'Deployment', commandText: result.commandText };
}

function lastNonEmptyLine(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}
