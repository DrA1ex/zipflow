import { WorkflowSession } from '../src/application/index.js';

export class MemoryWorkflowSessionRepository {
  constructor(record) {
    this.record = structuredClone(record);
    this.casCalls = 0;
    this.failures = new Map();
  }

  failOn(call, phase, message = `simulated ${phase} crash`) {
    this.failures.set(`${call}:${phase}`, new Error(message));
    return this;
  }

  async load(runId) {
    return this.record?.runId === runId ? structuredClone(this.record) : null;
  }

  async compareAndSwap(runId, expectedRevision, nextRecord) {
    this.casCalls += 1;
    const before = this.failures.get(`${this.casCalls}:before`);
    if (before) throw before;
    if (this.record.runId !== runId || this.record.revision !== expectedRevision) return false;
    this.record = structuredClone(nextRecord);
    const after = this.failures.get(`${this.casCalls}:after`);
    if (after) throw after;
    return structuredClone(this.record);
  }

  current() {
    return structuredClone(this.record);
  }
}

export function createWorkflowSession(repository, executor, prefix = 'fixture') {
  let sequence = 0;
  return new WorkflowSession({
    repository,
    executor,
    idFactory: () => `${prefix}-intent-${++sequence}`,
    clock: () => new Date(Date.UTC(2026, 6, 28, 0, 0, sequence)),
  });
}

export function recordForSurface(kind, { revision = 10, privateState = null } = {}) {
  return {
    runId: 'run-1',
    revision,
    snapshot: snapshotForSurface(kind),
    privateState,
    actions: [],
  };
}

export function snapshotForSurface(kind) {
  const snapshot = {
    project: { id: 'project-1', name: 'Fixture project' },
    workflow: { configured: true, deployment: { configured: true, label: 'Fixture deploy' } },
    run: { id: 'run-1', status: 'waiting_action', attention: kind, backupAvailable: true },
    operation: { id: 'operation-1', kind: 'apply', settlement: 'succeeded', cancellable: true },
    plan: {
      files: [{ id: 'file-1', path: 'src/a.js', change: 'updated', decision: 'archive' }],
      groups: [{ id: 'updated', label: 'Updated', count: 1 }],
      conflicts: [],
      unresolvedConflicts: 0,
    },
    checks: { status: 'succeeded', results: [] },
    rollback: { backupAvailable: true, warnings: ['Current files will be replaced.'] },
  };

  switch (kind) {
    case 'project_home':
      snapshot.run.status = 'created';
      snapshot.run.attention = 'project';
      break;
    case 'workflow_setup':
      snapshot.workflow.configured = false;
      snapshot.run.attention = 'workflow';
      break;
    case 'archive_inspecting':
      snapshot.run.status = 'inspecting';
      snapshot.run.attention = null;
      snapshot.operation = { id: 'inspect-1', kind: 'archive_inspection', settlement: 'active', cancellable: true };
      break;
    case 'archive_root_choice':
      snapshot.run.attention = 'archive_root';
      snapshot.archiveRootChoices = [{ id: 'root-a', label: 'Archive root' }];
      break;
    case 'archive_safety':
      snapshot.run.attention = 'archive_safety';
      snapshot.archiveSafety = { warnings: [{ code: 'link', message: 'Review archive link.' }] };
      break;
    case 'plan_review': snapshot.run.attention = 'plan'; break;
    case 'plan_files': snapshot.run.attention = 'plan_files'; break;
    case 'conflict_summary':
      snapshot.run.attention = 'conflicts';
      snapshot.plan.conflicts = [{ path: 'src/a.js', reason: 'Both versions changed.', decision: null }];
      snapshot.plan.unresolvedConflicts = 1;
      break;
    case 'conflict_file':
      snapshot.run.attention = 'conflict';
      snapshot.plan.currentConflict = { path: 'src/a.js', reason: 'Both versions changed.' };
      snapshot.plan.conflicts = [{ path: 'src/a.js', reason: 'Both versions changed.', decision: null }];
      snapshot.plan.unresolvedConflicts = 1;
      break;
    case 'operation_progress':
      snapshot.run.status = 'applying';
      snapshot.run.attention = null;
      snapshot.operation.settlement = 'active';
      break;
    case 'checks_failed':
      snapshot.run.status = 'failed';
      snapshot.run.attention = 'checks_failed';
      snapshot.checks = { status: 'failed', results: [{ id: 'tests', name: 'Tests', status: 'failed' }] };
      break;
    case 'commit_choice': snapshot.run.attention = 'commit'; break;
    case 'commit_message': snapshot.run.attention = 'commit_message'; break;
    case 'deploy_choice': snapshot.run.attention = 'deploy'; break;
    case 'completed':
      snapshot.run.status = 'completed';
      snapshot.run.attention = null;
      break;
    case 'history':
      snapshot.history = { open: true, runs: [{ id: 'run-old', status: 'completed' }] };
      break;
    case 'run_details':
      snapshot.history = { selectedRun: { id: 'run-old', files: [] } };
      break;
    case 'rollback_confirm':
      snapshot.run.attention = 'rollback';
      snapshot.rollback.pending = true;
      break;
    case 'error':
      snapshot.run.status = 'failed';
      snapshot.run.attention = 'error';
      snapshot.error = { code: 'FIXTURE_ERROR', message: 'Fixture failed.', retryable: true };
      break;
    default: throw new TypeError(`Unknown fixture surface: ${kind}`);
  }
  return snapshot;
}

export function actionInput(actionId) {
  if (actionId === 'save-workflow') return { workflow: {} };
  if (actionId === 'select-archive-root') return { rootId: 'root-a' };
  if (['use-archive', 'keep-local'].includes(actionId)) return { path: 'src/a.js' };
  if (actionId === 'resolve-conflict') return { path: 'src/a.js', decision: 'keep' };
  if (actionId === 'commit') return { message: 'Update project' };
  if (actionId === 'amend-commit') {
    return { targetId: 'amend-head', message: 'Update project' };
  }
  if (actionId === 'squash-commits') {
    return { targetId: 'squash-2', message: 'Update project' };
  }
  return {};
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
