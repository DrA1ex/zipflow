import { SURFACE_KINDS } from '../protocol/constants.js';
import { assertProtocolValue } from '../protocol/validation.js';
import { ActionRegistry } from './action-registry.js';
import { SURFACE_TEMPLATES } from './surface-templates.js';

const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const COMPLETED_STATUSES = new Set(['completed', 'cancelled', 'rolled_back']);

function cleanText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).replace(ANSI_PATTERN, '').replace(TERMINAL_CONTROL_PATTERN, '').slice(0, 16_384);
}

function cleanId(value, fallback) {
  const result = cleanText(value, '').trim().slice(0, 512);
  const safeFallback = cleanText(fallback, 'unknown').trim().slice(0, 512);
  return result || safeFallback || 'unknown';
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function bounded(values, limit = 100) {
  return Array.isArray(values) ? values.slice(0, limit) : [];
}

function runStatus(snapshot) {
  return snapshot.run?.status ?? snapshot.runStatus ?? null;
}

function operationIsActive(snapshot) {
  return ['active', 'cancel_requested', 'cancel_deferred'].includes(snapshot.operation?.settlement);
}

function conflictCount(snapshot) {
  if (Number.isSafeInteger(snapshot.plan?.unresolvedConflicts)) return snapshot.plan.unresolvedConflicts;
  return bounded(snapshot.plan?.conflicts).filter(({ decision } = {}) => !decision).length;
}

export function inferSurfaceKind(snapshot = {}) {
  if (snapshot.surfaceKind !== undefined) {
    if (!SURFACE_KINDS.includes(snapshot.surfaceKind)) {
      throw new TypeError(`Unknown surface kind: ${snapshot.surfaceKind}`);
    }
    return snapshot.surfaceKind;
  }

  const attention = snapshot.run?.attention ?? snapshot.attention;
  const status = runStatus(snapshot);
  if (snapshot.error || status === 'uncertain') return 'error';
  if (snapshot.rollback?.pending || attention === 'rollback') return 'rollback_confirm';
  if (snapshot.history?.selectedRun || snapshot.historyRun) return 'run_details';
  if (snapshot.history?.open || snapshot.view === 'history') return 'history';
  if (COMPLETED_STATUSES.has(status)) return 'completed';
  if (attention === 'deploy' || status === 'waiting_deploy') return 'deploy_choice';
  if (attention === 'commit_message') return 'commit_message';
  if (attention === 'commit' || status === 'waiting_commit') return 'commit_choice';
  if (snapshot.checks?.status === 'failed') return 'checks_failed';
  if (status === 'failed') return 'error';
  if (status === 'inspecting' || snapshot.operation?.kind === 'archive_inspection') return 'archive_inspecting';
  if (operationIsActive(snapshot)) return 'operation_progress';
  if (snapshot.plan?.currentConflict) return 'conflict_file';
  if (conflictCount(snapshot) > 0) return 'conflict_summary';
  if (snapshot.plan?.view === 'files') return 'plan_files';
  if (snapshot.plan) return 'plan_review';
  if (bounded(snapshot.archiveSafety?.warnings).length > 0) return 'archive_safety';
  if (bounded(snapshot.archiveRootChoices).length > 0) return 'archive_root_choice';
  if (snapshot.workflow?.configured === false || snapshot.view === 'workflow_setup') return 'workflow_setup';
  return 'project_home';
}

function projectFields(snapshot) {
  return [
    { id: 'project-id', 'label': 'Project ID', value: cleanText(snapshot.project?.id, 'unknown') },
    { id: 'project-name', 'label': 'Project', value: cleanText(snapshot.project?.name, 'Unnamed project') },
    { id: 'run-status', 'label': 'Run status', value: cleanText(runStatus(snapshot), 'idle') },
  ];
}

function projectProgress(snapshot) {
  const operation = snapshot.operation ?? {};
  return {
    phase: cleanText(operation.phase ?? operation.kind, 'working'),
    completed: finiteNumber(operation.completed, 0),
    total: finiteNumber(operation.total, 0),
    message: cleanText(operation.message, ''),
    cancellable: operation.cancellable === true,
  };
}

function projectChoices(snapshot) {
  return bounded(snapshot.archiveRootChoices).map((choice, position) => ({
    id: cleanId(choice?.id, `root-${position + 1}`),
    label: cleanText(choice?.label ?? choice?.path, `Root ${position + 1}`),
    description: cleanText(choice?.description, ''),
  }));
}

function workflowChoices(snapshot) {
  return bounded(snapshot.workflow?.options).map((choice, position) => ({
    id: cleanId(choice?.id, `workflow-option-${position + 1}`),
    label: cleanText(choice?.label, `Option ${position + 1}`),
    description: cleanText(choice?.description, ''),
  }));
}

function projectWarnings(snapshot, surfaceKind) {
  const source = surfaceKind === 'rollback_confirm'
    ? (snapshot.rollback?.warnings ?? ['Rollback will replace current project files.'])
    : snapshot.archiveSafety?.warnings;
  return bounded(source).map((warning, position) => ({
    code: cleanId(warning?.code, `warning-${position + 1}`),
    message: cleanText(warning?.message ?? warning, 'Review this warning.'),
    path: warning?.path ? cleanText(warning.path) : null,
  }));
}

function planFiles(snapshot) {
  const historyFiles = snapshot.history?.selectedRun?.files
    ?? snapshot.historyRun?.files
    ?? snapshot.run?.files;
  const source = snapshot.plan?.files
    ?? (snapshot.plan?.currentConflict ? [snapshot.plan.currentConflict] : historyFiles);
  return bounded(source).map((file, position) => ({
    id: cleanId(file?.id, `file-${position + 1}`),
    path: cleanText(file?.path, `file-${position + 1}`),
    change: cleanText(file?.change ?? file?.kind, 'change'),
    decision: file?.decision === 'archive' || file?.decision === 'keep' ? file.decision : null,
  }));
}

function planGroups(snapshot) {
  return bounded(snapshot.plan?.groups).map((group, position) => ({
    id: cleanId(group?.id, `group-${position + 1}`),
    label: cleanText(group?.label, `Group ${position + 1}`),
    count: Number.isSafeInteger(group?.count) ? group.count : 0,
  }));
}

function conflicts(snapshot) {
  const source = snapshot.plan?.conflicts?.length
    ? snapshot.plan.conflicts
    : (snapshot.plan?.currentConflict ? [snapshot.plan.currentConflict] : []);
  return bounded(source).map((conflict, position) => ({
    id: cleanId(conflict?.id, `conflict-${position + 1}`),
    path: cleanText(conflict?.path, `conflict-${position + 1}`),
    reason: cleanText(conflict?.reason, 'Local and archive versions differ.'),
    decision: conflict?.decision === 'archive' || conflict?.decision === 'keep' ? conflict.decision : null,
  }));
}

function checkResults(snapshot) {
  return bounded(snapshot.checks?.results).map((result, position) => ({
    id: cleanId(result?.id, `check-${position + 1}`),
    name: cleanText(result?.name, `Check ${position + 1}`),
    status: cleanText(result?.status, 'unknown'),
    summary: cleanText(result?.summary ?? result?.output, ''),
  }));
}

function historyRows(snapshot) {
  return bounded(snapshot.history?.runs).map((run, position) => ({
    id: cleanId(run?.id, `run-${position + 1}`),
    status: cleanText(run?.status, 'unknown'),
    summary: cleanText(run?.summary, ''),
    createdAt: cleanText(run?.createdAt, ''),
    link: `/v1/runs/${encodeURIComponent(cleanId(run?.id, `run-${position + 1}`))}`,
  }));
}

function projectError(snapshot) {
  const source = snapshot.error ?? snapshot.checks?.error ?? {};
  return {
    code: cleanId(source.code, 'ZIPFLOW_ERROR'),
    message: cleanText(source.message ?? source, 'The operation could not continue.'),
    retryable: source.retryable === true,
  };
}

function sectionContent(kind, snapshot, surfaceKind) {
  switch (kind) {
    case 'text': return { text: 'Workflow settings are semantic project data and do not depend on a terminal client.' };
    case 'summary_fields': return { fields: projectFields(snapshot) };
    case 'progress': return projectProgress(snapshot);
    case 'choice_list': return { choices: surfaceKind === 'workflow_setup' ? workflowChoices(snapshot) : projectChoices(snapshot) };
    case 'plan_summary': return { files: planFiles(snapshot).length, groups: planGroups(snapshot).length, unresolvedConflicts: conflictCount(snapshot) };
    case 'file_groups': return { groups: planGroups(snapshot) };
    case 'file_details': return { files: planFiles(snapshot), truncated: (snapshot.plan?.files?.length ?? 0) > 100 };
    case 'conflict': return { conflicts: conflicts(snapshot), unresolved: conflictCount(snapshot) };
    case 'check_results': return { status: cleanText(snapshot.checks?.status, 'unknown'), results: checkResults(snapshot) };
    case 'commit': return { suggestedMessage: cleanText(snapshot.commit?.suggestedMessage, ''), messageRequired: true };
    case 'deployment': return { configured: snapshot.workflow?.deployment?.configured === true, label: cleanText(snapshot.workflow?.deployment?.label, 'Configured deployment') };
    case 'history_rows': return { rows: historyRows(snapshot), truncated: (snapshot.history?.runs?.length ?? 0) > 100 };
    case 'warning_list': return { warnings: projectWarnings(snapshot, surfaceKind) };
    case 'error': return projectError(snapshot);
    default: throw new TypeError(`Unsupported section kind: ${kind}`);
  }
}

function projectSections(template, snapshot) {
  return template.sections.map((kind, position) => ({
    id: `${template.kind}-${kind}-${position + 1}`,
    kind,
    ...sectionContent(kind, snapshot, template.kind),
  }));
}

function actionEntries(template, snapshot) {
  const unresolved = conflictCount(snapshot);
  const deployConfigured = snapshot.workflow?.deployment?.configured === true;
  const backupAvailable = snapshot.rollback?.backupAvailable === true
    || snapshot.run?.backupAvailable === true;

  return template.actions.map((id) => {
    if (id === 'save-workflow' && snapshot.workflow?.inputSchema) {
      return { id, inputSchema: snapshot.workflow.inputSchema };
    }
    if (id === 'approve-plan' && unresolved > 0) {
      return { id, enabled: false, 'disabledReason': 'Resolve all conflicts before applying the plan.' };
    }
    if (id === 'deploy' && !deployConfigured) {
      return { id, enabled: false, 'disabledReason': 'No deployment workflow is configured.' };
    }
    if (id === 'rollback' && !backupAvailable) {
      return { id, enabled: false, 'disabledReason': 'No restorable backup is available.' };
    }
    if (id === 'cancel-operation' && !operationIsActive(snapshot)) {
      return { id, enabled: false, 'disabledReason': 'There is no cancellable operation.' };
    }
    if (id === 'retry-run' && template.kind === 'error' && snapshot.error?.retryable !== true) {
      return { id, enabled: false, 'disabledReason': 'This error is not retryable.' };
    }
    return id;
  });
}

function surfaceRevision(snapshot) {
  const revision = snapshot.surfaceRevision
    ?? snapshot.revision
    ?? snapshot.run?.surfaceRevision
    ?? snapshot.run?.revision
    ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('A surface revision must be a non-negative safe integer.');
  }
  return revision;
}

function surfaceLinks(snapshot, kind) {
  const projectId = snapshot.project?.id;
  const runId = snapshot.run?.id;
  const links = {};
  if (projectId) links.project = `/v1/projects/${encodeURIComponent(projectId)}`;
  if (projectId) links.workflow = `/v1/projects/${encodeURIComponent(projectId)}/workflow`;
  if (projectId) links.history = `/v1/projects/${encodeURIComponent(projectId)}/history`;
  if (runId) links.run = `/v1/runs/${encodeURIComponent(runId)}`;
  if (runId) links.plan = `/v1/runs/${encodeURIComponent(runId)}/plan`;
  if (runId) links.report = `/v1/runs/${encodeURIComponent(runId)}/report`;
  if (runId) links.self = `/v1/runs/${encodeURIComponent(runId)}/surface`;
  else if (projectId) links.self = `/v1/projects/${encodeURIComponent(projectId)}/surface`;
  else links.self = `/v1/surfaces/${kind}`;
  return links;
}

export class SurfaceProjector {
  constructor({ actionRegistry = new ActionRegistry() } = {}) {
    this.actionRegistry = actionRegistry;
  }

  project(snapshot = {}) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError('An application snapshot must be an object.');
    }

    const kind = inferSurfaceKind(snapshot);
    const template = SURFACE_TEMPLATES[kind];
    const ownerId = snapshot.run?.id ?? snapshot.project?.id ?? 'global';
    const surface = {
      id: cleanId(snapshot.surfaceId, `${kind}:${ownerId}`),
      kind,
      revision: surfaceRevision(snapshot),
      'title': cleanText(snapshot.surfaceTitle, template.title),
      summary: cleanText(snapshot.surfaceSummary, template.summary),
      stage: { ...template.stage },
      sections: projectSections(template, snapshot),
      actions: this.actionRegistry.advertise(actionEntries(template, snapshot)),
      links: surfaceLinks(snapshot, kind),
    };

    assertProtocolValue('surface', surface);
    return surface;
  }
}

export function projectSurface(snapshot, options) {
  return new SurfaceProjector(options).project(snapshot);
}
