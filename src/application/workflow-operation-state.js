import path from 'node:path';
import { deploymentAvailable, nextPostCheckAttention } from './post-apply-runner.js';

const MAX_OUTPUT_CHARS = 64 * 1024;
const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function archiveOutcome(context, result) {
  const status = result.outcome === 'completed' ? 'completed' : 'waiting_action';
  const attention = result.attention ?? null;
  const executable = clone(result.executable);
  return operationOutcome({
    status, attention,
    snapshot: transitionSnapshot(context, executable, archivePublic(result.public)),
    privateState: executable,
    legacy: {
      archiveMetadata: clone(executable.metadata), archiveSafety: clone(executable.safety),
      plan: clone(executable.plan), patch: clone(executable.patch),
      decisions: clone(executable.decisions ?? []),
      status: status === 'completed' ? 'no_changes' : 'planned',
    },
  });
}

export function postCheckOutcome(context, privateState, snapshot, legacy, checks, outputs) {
  const attention = nextPostCheckAttention({
    workflow: privateState.workflow, applied: privateState.applied, checks,
  });
  const semanticAttention = attention === 'checks' ? 'checks_failed' : attention;
  const status = semanticAttention ? 'waiting_action' : 'completed';
  return operationOutcome({
    status, attention: semanticAttention, snapshot, privateState,
    legacy: {
      ...legacy,
      status: checks?.ok ? (status === 'completed' ? 'completed' : 'checks_passed') : 'checks_failed',
    },
    outputs,
  });
}

export function operationOutcome({ status, attention, snapshot, privateState, legacy, outputs = [] }) {
  return {
    status,
    snapshot: {
      ...snapshot,
      run: {
        ...snapshot.run, status, attention,
        backupAvailable: privateState.applied?.backupAvailable === true,
      },
      operation: null,
      error: null,
    },
    privateState,
    legacy,
    outputs,
  };
}

export function transitionSnapshot(context, privateState, changes = {}) {
  const base = snapshotBase(context);
  return {
    ...base, ...changes,
    run: {
      ...base.run,
      backupAvailable: privateState?.applied?.backupAvailable === true,
    },
  };
}

export function snapshotBase(context) {
  const source = context.session.publicSummary ?? {};
  const workflow = context.privateState?.workflow ?? {};
  const keep = {};
  for (const key of [
    'archiveRootChoices', 'archiveSafety', 'plan', 'checks', 'commit', 'deployment', 'rollback',
  ]) {
    if (source[key] !== undefined) keep[key] = clone(source[key]);
  }
  return {
    ...keep,
    project: {
      id: context.session.binding.projectId,
      name: safeText(context.project?.name || path.basename(context.session.binding.projectPath), 512),
    },
    workflow: {
      configured: true,
      revision: context.session.binding.workflowRevision,
      name: safeText(workflow.name || source.workflow?.name || 'Workflow', 512),
      deployment: {
        configured: deploymentAvailable(workflow),
        label: deploymentAvailable(workflow) ? 'Deployment' : 'Deployment disabled',
      },
    },
    run: {
      id: context.session.run.runId,
      status: context.session.run.status,
      attention: source.run?.attention ?? null,
      backupAvailable: context.privateState?.applied?.backupAvailable === true,
    },
  };
}

function archivePublic(value = {}) {
  return {
    archiveRootChoices: clone(value.archiveRootChoices ?? []),
    archiveSafety: clone(value.archiveSafety ?? null),
    plan: clone(value.plan ?? null),
  };
}

export function publicApplied(value = {}) {
  return {
    paths: relativePaths(value.paths), changedPaths: relativePaths(value.changedPaths),
    counts: clone(value.counts ?? {}), excludedPaths: relativePaths(value.excludedPaths),
    backupAvailable: value.backupAvailable === true,
    skippedConflicts: relativePaths(value.skippedConflicts),
    preservedPaths: relativePaths(value.preservedPaths),
  };
}

export function publicChecks(checks = {}) {
  const results = Array.isArray(checks.results) ? checks.results : [];
  return {
    status: checks.ok === true ? 'passed' : 'failed',
    ok: checks.ok === true,
    passed: finiteCount(checks.passed), failed: finiteCount(checks.failed),
    skipped: finiteCount(checks.skipped),
    results: results.slice(0, 100).map((item, index) => ({
      id: safeText(item?.id || `check-${index + 1}`, 512),
      name: safeText(item?.name || `Check ${index + 1}`, 512),
      ok: item?.ok === true,
      required: item?.required !== false,
      code: Number.isSafeInteger(item?.code) ? item.code : null,
      durationMs: Number.isSafeInteger(item?.durationMs) ? item.durationMs : null,
      cwd: safeRelativeDirectory(item?.cwd),
      status: item?.ok === true ? 'passed' : 'failed',
      summary: item?.ok === true ? 'Check passed.' : 'Check failed. See bounded run output.',
    })),
    ...(checks.ok === true ? {} : {
      error: {
        code: 'CHECKS_FAILED',
        message: 'One or more required project checks failed.',
        retryable: true,
      },
    }),
  };
}

export function publicCommit(value = {}) {
  return {
    revision: safeText(value.revision, 512),
    message: safeText(value.message, 4_096),
    strategy: safeText(value.strategy, 128),
  };
}

export function publicDeployment(value = {}, workflow = {}) {
  return {
    configured: deploymentAvailable(workflow),
    label: 'Deployment',
    status: value.ok === true ? 'succeeded' : 'failed',
  };
}

export function withRevision(snapshot, revision) {
  return {
    ...snapshot, revision, surfaceRevision: revision,
    run: { ...snapshot.run, revision },
  };
}

export function minimalLegacy(context) {
  return {
    version: 9, id: context.session.run.runId,
    projectPath: context.session.binding.projectPath,
    projectName: context.project?.name ?? path.basename(context.session.binding.projectPath),
    workflowName: context.privateState?.workflow?.name ?? 'Workflow',
    status: 'created', createdAt: context.session.run.createdAt,
  };
}

export function publicError(error, kind) {
  const code = /^[A-Z][A-Z0-9_]{1,127}$/.test(String(error?.code ?? ''))
    ? error.code : 'WORKFLOW_OPERATION_FAILED';
  const labels = {
    archive_inspection: 'archive inspection', archive_root: 'archive root selection',
    apply: 'project update', checks: 'project checks', commit: 'Git commit',
    deploy: 'deployment', rollback: 'rollback',
  };
  return {
    code,
    message: `The ${labels[kind] ?? 'workflow'} operation could not be completed.`,
    retryable: ['archive_root', 'checks'].includes(kind),
    ...(['archive_root', 'checks'].includes(kind) ? { retryKind: kind } : {}),
  };
}

export function requireWorkflow(privateState) {
  if (!privateState?.workflow) {
    throw runnerError('Run execution manifest is incomplete.', 'SERVER_STORAGE_CORRUPT', 500);
  }
  return privateState.workflow;
}

export function selectedChecks(workflow) {
  return (workflow?.checks ?? []).filter((check) => check.selected);
}

function relativePaths(values) {
  return (Array.isArray(values) ? values : []).map((value) => {
    const normalized = String(value).replaceAll('\\', '/');
    if (!normalized || path.posix.isAbsolute(normalized) || path.posix.normalize(normalized) !== normalized) {
      throw runnerError('A public run path is invalid.', 'SERVER_STORAGE_CORRUPT', 500);
    }
    return normalized;
  });
}

export function cleanOutput(value) {
  return String(value ?? '')
    .replace(ANSI_PATTERN, '')
    .replace(CONTROL_PATTERN, '')
    .slice(0, MAX_OUTPUT_CHARS);
}

function safeText(value, limit) {
  return String(value ?? '').replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '').slice(0, limit);
}

function safeRelativeDirectory(value) {
  const normalized = String(value ?? '.').replaceAll('\\', '/').replace(/^\.\//, '') || '.';
  if (normalized === '.') return '.';
  if (path.posix.isAbsolute(normalized) || path.posix.normalize(normalized) !== normalized
    || normalized.split('/').some((part) => !part || part === '..')) return null;
  return normalized;
}

export function finiteCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function safeTimestamp(value) {
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export function assertPublicSnapshot(value) {
  visit(value, (item) => {
    if (typeof item !== 'string') return;
    if (path.posix.isAbsolute(item) || /^[A-Za-z]:[\\/]/.test(item) || /^file:\/\//i.test(item)) {
      throw runnerError('Public workflow state contains a private path.', 'SERVER_STORAGE_CORRUPT', 500);
    }
  });
}

function visit(value, callback) {
  callback(value);
  if (Array.isArray(value)) for (const item of value) visit(item, callback);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item, callback);
}

export function runnerError(message, code, status) {
  return Object.assign(new Error(message), {
    code, status, expose: status < 500, detail: message,
  });
}

export function clone(value) {
  return value == null ? value : structuredClone(value);
}
