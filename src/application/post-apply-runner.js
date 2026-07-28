import { runChecks } from '../checks/runner.js';
import { runDeploy } from '../deploy/runner.js';
import { createCommit } from '../git/repository.js';
import { gitHooksAllowed } from '../git/hooks.js';

const MAX_OUTPUT_CHARS = 256 * 1024;

export async function runConfiguredChecks({
  workflow,
  projectPath,
  changedPaths = [],
  checkIds = null,
  settings = null,
  signal = null,
  onProgress = null,
} = {}) {
  const selected = selectChecks(workflow, checkIds);
  const output = [];
  const configuredWorkflow = {
    ...structuredClone(workflow),
    checks: workflow.checks.map((check) => ({
      ...check,
      selected: selected.has(check.id),
    })),
  };
  const checks = await runChecks({
    workflow: configuredWorkflow,
    projectPath,
    changedPaths,
    settings,
    signal,
    onUpdate: (event) => {
      if (event.type === 'output') appendOutput(output, event.event?.text);
      onProgress?.(publicCheckProgress(event));
    },
  });
  return {
    checks,
    output: output.join(''),
    selectedCheckIds: [...selected],
  };
}

export async function commitAppliedRun({
  workflow,
  projectPath,
  appliedPaths,
  message,
  signal = null,
} = {}) {
  const normalizedMessage = String(message ?? '').trim();
  if (!normalizedMessage) {
    throw actionInputError('A non-empty commit message is required.');
  }
  if (!Array.isArray(appliedPaths) || !appliedPaths.length) {
    throw actionInputError('There are no applied paths to commit.');
  }
  const result = await createCommit(projectPath, appliedPaths, normalizedMessage, {
    signal,
    allowHooks: gitHooksAllowed(workflow),
  });
  if (!result.ok) {
    throw Object.assign(new Error('The configured Git commit could not be created.'), {
      code: 'GIT_COMMIT_FAILED',
      status: 409,
      expose: true,
      detail: result.reason || 'The configured Git commit could not be created.',
    });
  }
  return {
    revision: result.revision,
    message: normalizedMessage,
    strategy: 'create-new',
    paths: result.paths,
    omittedPaths: result.omittedPaths,
  };
}

export async function runConfiguredDeployment({
  workflow,
  projectPath,
  settings = null,
  signal = null,
  onProgress = null,
} = {}) {
  if (
    workflow?.deploy?.policy === 'disabled'
    || typeof workflow?.deploy?.commandText !== 'string'
    || !workflow.deploy.commandText.trim()
  ) {
    throw Object.assign(new Error('Deployment is not configured for this workflow.'), {
      code: 'ACTION_NOT_AVAILABLE',
      status: 409,
      expose: true,
      detail: 'Deployment is not configured for this workflow.',
    });
  }
  const result = await runDeploy({
    deploy: workflow.deploy,
    projectPath,
    settings,
    signal,
    onOutput: (event) => onProgress?.({
      phase: 'deploy',
      output: boundedText(event?.text, 8_192),
    }),
  });
  return {
    ...result,
    policy: workflow.deploy.policy,
    commandText: workflow.deploy.commandText,
    cwd: workflow.deploy.cwd || '.',
  };
}

export function nextPostCheckAttention({ workflow, applied, checks }) {
  if (!checks?.ok) return 'checks';
  if (applied?.paths?.length && workflow?.git?.resultCommit !== 'never') return 'commit';
  if (deploymentAvailable(workflow)) return 'deploy';
  return null;
}

export function nextPostCommitAttention(workflow) {
  return deploymentAvailable(workflow) ? 'deploy' : null;
}

export function deploymentAvailable(workflow) {
  return workflow?.deploy?.policy !== 'disabled'
    && typeof workflow?.deploy?.commandText === 'string'
    && Boolean(workflow.deploy.commandText.trim());
}

function selectChecks(workflow, checkIds) {
  if (!Array.isArray(workflow?.checks)) throw new TypeError('A workflow with configured checks is required.');
  const available = new Map(
    workflow.checks
      .filter((check) => check.selected)
      .map((check) => [check.id, check]),
  );
  const requested = checkIds == null ? [...available.keys()] : checkIds;
  if (!Array.isArray(requested) || requested.some((id) => typeof id !== 'string' || !id)) {
    throw actionInputError('checkIds must be an array of configured check IDs.');
  }
  const unique = new Set(requested);
  const unknown = [...unique].filter((id) => !available.has(id));
  if (unknown.length) {
    throw Object.assign(new Error('One or more requested checks are not selected in the workflow.'), {
      code: 'ACTION_INPUT_INVALID',
      status: 400,
      expose: true,
      detail: 'One or more requested checks are not selected in the workflow.',
      details: { unknownCheckIds: unknown },
    });
  }
  return unique;
}

function publicCheckProgress(event) {
  return {
    phase: 'checks',
    type: event.type,
    checkId: event.check?.id ?? null,
    completed: event.type === 'finished' ? event.index + 1 : event.index,
    total: event.total ?? null,
  };
}

function appendOutput(chunks, value) {
  const remaining = MAX_OUTPUT_CHARS - chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (remaining <= 0) return;
  chunks.push(boundedText(value, remaining));
}

function boundedText(value, limit) {
  const text = String(value ?? '').replaceAll('\u0000', '');
  return text.length <= limit ? text : text.slice(0, limit);
}

function actionInputError(message) {
  return Object.assign(new Error(message), {
    code: 'ACTION_INPUT_INVALID',
    status: 400,
    expose: true,
    detail: message,
  });
}
