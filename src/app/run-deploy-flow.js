import { runDeploy } from '../deploy/runner.js';
import { saveRunRecord } from '../runs/store.js';
import { confirmRollback, performRollback, showRunDetails } from './run-rollback.js';
import { failRun, releaseRunResources } from './run-lifecycle.js';
import { clearRunSettings } from './runtime-settings.js';
import { decideDeployment, handleDeploymentFailureAutonomy } from './run-autonomy.js';
import { completeRun, showCompleted } from './run-completion.js';
import { autopilotPaused } from './autonomy-flow.js';
import { captureRunExecutionState } from './run-state-integrity.js';
import { commandLocationLabel } from '../project/command-spec.js';

export async function continueToDeploy(controller) {
  const { state } = controller;
  const policy = state.workflow.deploy?.policy ?? 'disabled';
  const failedChecks = hasFailedChecks(state);
  const finalStatus = failedChecks ? 'completed_with_errors' : 'completed';
  if (policy === 'disabled' || policy === 'on-demand') return completeRun(controller, finalStatus);
  const handled = await decideDeployment(controller, {
    failedChecks,
    run: (_decision, executionState) => startDeploy(controller, { expectedState: executionState }),
    skip: async () => {
      state.run.deploy = { skipped: true, policy, commandText: state.workflow.deploy.commandText, cwd: state.workflow.deploy.cwd || '.', autonomous: true };
      state.run = await saveRunRecord(state.run);
      return completeRun(controller, finalStatus);
    },
  });
  if (handled !== false) return handled;
  if (policy === 'always') return startDeploy(controller);
  if (policy === 'ask') return showDeployPrompt(controller);
  return completeRun(controller, finalStatus);
}

export function showDeployPrompt(controller) {
  const deploy = controller.state.workflow.deploy;
  const failedChecks = hasFailedChecks(controller.state);
  controller.showMenu('deploy-prompt', [
    ...(autopilotPaused(controller.state) ? [{ id: 'resume-autopilot', label: 'Resume autopilot', description: 'Ask the local model to decide deployment again.' }] : []),
    { id: 'run-deploy', label: 'Run deployment', description: `${commandLocationLabel(deploy.cwd)} · ${deploy.commandText}` },
    { id: 'skip-deploy', label: 'Finish without deployment', description: 'Keep the recorded local update without running the configured deployment command.' },
  ], failedChecks ? 'Deployment after failed checks' : 'Checks passed · deployment is ready', 0,
  failedChecks ? ['Required checks failed. Full autopilot or an explicit manual choice may still run the configured deployment.'] : []);
}

export async function startDeploy(controller, { fromCompleted = false, expectedState = null } = {}) {
  const { state } = controller;
  const operation = controller.beginOperation({ kind: 'deployment', label: 'Running deployment' });
  const deploy = state.workflow.deploy;
  const beforeState = expectedState ?? await captureRunExecutionState(state);
  state.screen = 'deploy-running';
  state.deployRuntime = { commandText: deploy.commandText, cwd: deploy.cwd || '.', lastLine: '', fromCompleted };
  state.status = 'Deploying';
  controller.invalidate();
  try {
    const currentState = await captureRunExecutionState(state);
    if (beforeState.hash !== currentState.hash) throw driftError('Project, Git, or workflow state changed before deployment.');
    const result = await runDeploy({
      deploy,
      projectPath: state.project.root,
      signal: operation.signal,
      onOutput: (event) => {
        state.deployRuntime.lastLine = lastNonEmptyLine(event.text);
        controller.invalidate();
      },
    });
    state.run.deploy = { ...result, policy: deploy.policy, commandText: deploy.commandText, cwd: deploy.cwd || '.' };
    state.run = await saveRunRecord(state.run);
    if (!result.ok) {
      controller.message('Deployment failed', [
        `Directory: ${commandLocationLabel(deploy.cwd)}`,
        deploy.commandText,
        lastNonEmptyLine(`${result.stdout}\n${result.stderr}`) || 'No output',
      ], 'error', { collapsedSummary: `Deployment · failed · ${deploy.commandText}` });
      return operation.handoff(async () => {
        const handled = await handleDeploymentFailureAutonomy(controller, {
          retry: () => startDeploy(controller),
          finishWithError: () => completeRun(controller, 'completed_with_errors'),
          rollbackLocal: () => automaticRollback(controller, { externalEffectsWarning: true }),
        });
        if (handled !== false) return handled;
        return showDeployFailed(controller);
      });
    }
    controller.message('Deployment completed', [`${commandLocationLabel(deploy.cwd)} · ${deploy.commandText}`], 'success', { collapsedSummary: `Deployment · completed · ${deploy.commandText}` });
    return operation.handoff(() => (
      fromCompleted
        ? showCompleted(controller)
        : completeRun(controller, hasFailedChecks(state) ? 'completed_with_errors' : 'completed')
    ));
  } catch (error) {
    if (error.code === 'cancelled') return showDeployCancelled(controller);
    await failRun(controller, error);
  } finally {
    operation.finish();
  }
}

export async function activateDeployFailure(controller, itemId) {
  const { state } = controller;
  if (itemId === 'view-deploy-output') {
    controller.message('Deployment output', [state.run.deploy.stdout, state.run.deploy.stderr].filter(Boolean).join('\n').split('\n'));
    return showDeployFailed(controller);
  }
  if (itemId === 'retry-deploy') return startDeploy(controller);
  if (itemId === 'finish-deploy-error') return completeRun(controller, 'completed_with_errors');
  if (itemId === 'rollback') return confirmRollback(controller, state.run);
}

export function skipDeploymentFromPrompt(controller) {
  const { state } = controller;
  state.run.deploy = { skipped: true, policy: state.workflow.deploy.policy, commandText: state.workflow.deploy.commandText, cwd: state.workflow.deploy.cwd || '.' };
  return completeRun(controller, hasFailedChecks(state) ? 'completed_with_errors' : 'completed');
}

export async function automaticRollback(controller, { externalEffectsWarning = false } = {}) {
  const result = await performRollback(controller, { automatic: true });
  if (!result) return false;
  if (externalEffectsWarning) {
    controller.message('External effects may remain', ['Local rollback cannot undo changes already made by a deployment command.'], 'warning');
  }
  await releaseRunResources(controller);
  clearRunSettings(controller.state);
  return showRunDetails(controller, controller.state.run, { origin: 'completed' });
}

async function showDeployCancelled(controller) {
  controller.state.run.deploy = {
    cancelled: true, ok: false, policy: controller.state.workflow.deploy.policy,
    commandText: controller.state.workflow.deploy.commandText,
    cwd: controller.state.workflow.deploy.cwd || '.',
  };
  controller.state.run = await saveRunRecord(controller.state.run);
  controller.showMenu('deploy-cancelled', [
    { id: 'retry-deploy', label: 'Run deployment again' },
    { id: 'finish-deploy-error', label: 'Finish and keep the update' },
    { id: 'rollback', label: 'Roll back local update', context: 'External deployment effects, if any, cannot be undone by Zipflow.' },
  ], 'Deployment cancelled');
}

function showDeployFailed(controller) {
  controller.showMenu('deploy-failed', [
    { id: 'view-deploy-output', label: 'View full deployment output' },
    { id: 'retry-deploy', label: 'Run deployment again' },
    { id: 'finish-deploy-error', label: 'Finish and keep the update', description: 'Record the deployment failure without rolling back local files' },
    { id: 'rollback', label: 'Roll back local update', description: 'External deployment effects cannot be undone by Zipflow' },
  ], 'Deployment failed');
}

function hasFailedChecks(state) {
  return Boolean(state.run.checks?.failed || state.run.checks?.cancelled || state.postCheckContinuation?.failedChecks);
}

function driftError(message) {
  const error = new Error(message);
  error.code = 'state_drift';
  return error;
}

function lastNonEmptyLine(value) {
  return String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}
