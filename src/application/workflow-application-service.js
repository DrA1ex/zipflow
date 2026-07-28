import { createActionRunRecord, createRunRecord, loadRunRecord, saveRunRecord } from '../runs/store.js';
import { createRunId } from '../utils/id.js';
import { discoverProject } from '../project/detect.js';
import { loadPlanItemDiff } from '../diff/file.js';
import { loadStoredFileDiff } from '../diff/stored-patch.js';
import { fingerprintRequest } from '../server/idempotency-store.js';
import { terminalRunStatus } from '../server/run-session-model.js';
import {
  assertManifestDiffPath,
  projectDiffResource,
  projectHistoryResource,
  projectOutputResource,
  projectPlanResource,
  projectReportResource,
  projectRunResource,
} from '../server/run-resource-projections.js';
import { deploymentAvailable } from './post-apply-runner.js';
import { projectAcceptsNewRun } from './project-operation-availability.js';
import { SemanticActionExecutor } from './semantic-action-executor.js';
import { WorkflowOperationRunner } from './workflow-operation-runner.js';
import { WorkflowSession } from './workflow-session.js';

const START_KINDS = new Set(['archive-run-start', 'check-run-start']);

export class WorkflowApplicationService {
  constructor({
    projects,
    workflows,
    blobs,
    sessions,
    operations,
    idempotency,
    journal,
    operationRunner = null,
    inspectProject = discoverProject,
    createArchiveRecord = createRunRecord,
    createCheckRecord = createActionRunRecord,
    loadLegacyRun = loadRunRecord,
    saveLegacyRun = saveRunRecord,
    createId = createRunId,
    onError = () => {},
  } = {}) {
    for (const [name, service] of Object.entries({
      projects, workflows, blobs, sessions, operations, idempotency, journal,
    })) {
      if (!service) throw new TypeError(`Workflow application service requires ${name}.`);
    }
    this.projects = projects;
    this.workflows = workflows;
    this.blobs = blobs;
    this.sessions = sessions;
    this.operations = operations;
    this.idempotency = idempotency;
    this.journal = journal;
    this.inspectProject = inspectProject;
    this.createArchiveRecord = createArchiveRecord;
    this.createCheckRecord = createCheckRecord;
    this.loadLegacyRun = loadLegacyRun;
    this.saveLegacyRun = saveLegacyRun;
    this.createId = createId;
    this.onError = onError;
    this.actionExecutor = new SemanticActionExecutor({ operations });
    this.workflowSession = new WorkflowSession({
      repository: sessions.workflowRepository(),
      executor: this.actionExecutor,
    });
    this.operationRunner = operationRunner ?? new WorkflowOperationRunner({
      sessions,
      journal,
      discoverProject: inspectProject,
      loadLegacyRun,
      saveLegacyRun,
    });
    this.background = new Set();
  }

  async startArchiveRun({ projectId, body, idempotencyKey }) {
    const request = archiveRequest(body);
    const fingerprint = fingerprintRequest({
      method: 'POST', path: `/v1/projects/${projectId}/runs`, body: request,
    });
    const runId = this.createId();
    const claim = await this.idempotency.claim({
      key: idempotencyKey,
      fingerprint,
      metadata: { kind: 'archive-run-start', projectId, runId, blobId: request.blobId },
    });
    const replay = await this.replayStartClaim(claim);
    if (replay) return replay;

    try {
      const context = await this.loadStartContext(projectId, { blobId: request.blobId });
      await this.assertProjectAvailable(projectId);
      const legacy = await this.createArchiveRecord({
        id: runId,
        project: context.discovered,
        workflow: context.workflow,
        archivePath: context.blob.path,
        archiveHash: context.blob.sha256,
        archiveInfo: { size: context.blob.size, modifiedAt: context.blob.createdAt },
      });
      const handle = await this.operations.begin({
        projectId,
        runId,
        kind: 'archive_inspection',
        metadata: { blobId: context.blob.blobId },
      });
      legacy.status = 'inspecting';
      await this.saveLegacyRun(legacy);
      await this.sessions.create({
        runId,
        binding: binding(context, runId),
        kind: 'archive',
        seriesId: request.seriesId,
        operationId: handle.operationId,
        status: 'inspecting',
        correlation: request.correlation,
        executionManifest: archivePrivateState(context, runId),
        publicSummary: initialSnapshot(context, runId, handle.operationId, 'archive_inspection', 'inspecting'),
      });
      const response = startResponse(runId, handle.operationId);
      await this.journal.append('surface.changed', eventFields(context, runId, handle.operationId, 1));
      await this.idempotency.complete({ key: idempotencyKey, fingerprint, receipt: response });
      this.launch({ handle, launch: { runId, kind: 'archive_inspection', input: {} } });
      return response;
    } catch (error) {
      await this.idempotency.markUncertain({ key: idempotencyKey, fingerprint }).catch(() => {});
      throw error;
    }
  }

  async startCheckRun({ projectId, body, idempotencyKey }) {
    const request = checkRequest(body);
    const fingerprint = fingerprintRequest({
      method: 'POST', path: `/v1/projects/${projectId}/check-runs`, body: request,
    });
    const runId = this.createId();
    const claim = await this.idempotency.claim({
      key: idempotencyKey,
      fingerprint,
      metadata: { kind: 'check-run-start', projectId, runId },
    });
    const replay = await this.replayStartClaim(claim);
    if (replay) return replay;

    try {
      const context = await this.loadStartContext(projectId);
      const checkIds = validateCheckIds(context.workflow, request.checkIds);
      await this.assertProjectAvailable(projectId);
      const legacy = await this.createCheckRecord({
        id: runId, project: context.discovered, workflow: context.workflow, action: 'manual-checks',
      });
      const handle = await this.operations.begin({ projectId, runId, kind: 'checks' });
      legacy.status = 'checking';
      await this.saveLegacyRun(legacy);
      await this.sessions.create({
        runId,
        binding: binding(context, runId),
        kind: 'checks',
        seriesId: request.seriesId,
        operationId: handle.operationId,
        status: 'checking',
        executionManifest: checkPrivateState(context, runId, checkIds),
        publicSummary: initialSnapshot(context, runId, handle.operationId, 'checks', 'checking'),
      });
      const response = startResponse(runId, handle.operationId);
      await this.journal.append('surface.changed', eventFields(context, runId, handle.operationId, 1));
      await this.idempotency.complete({ key: idempotencyKey, fingerprint, receipt: response });
      this.launch({ handle, launch: { runId, kind: 'checks', input: { checkIds } } });
      return response;
    } catch (error) {
      await this.idempotency.markUncertain({ key: idempotencyKey, fingerprint }).catch(() => {});
      throw error;
    }
  }

  async dispatchAction({ runId, actionId, expectedRevision, input, idempotencyKey }) {
    const response = await this.workflowSession.dispatchAction({
      runId, actionId, expectedRevision, input, idempotencyKey,
    });
    const launch = response.receipt?.response?.result?.launch ?? null;
    if (launch && !response.replayed) {
      const handle = this.actionExecutor.takeOperationHandle(launch.operationId);
      if (!handle) throw serviceError('Durable action operation handle is missing.', 'SERVER_STORAGE_CORRUPT', 500);
      this.launch({ handle, launch });
    }
    return {
      status: launch ? 202 : 200,
      headers: { etag: quoteRevision(response.revision) },
      body: response,
    };
  }

  async getRun(value) {
    const runId = resourceRunId(value);
    return projectRunResource(await this.requireSession(runId));
  }

  getSurface(value) {
    const runId = resourceRunId(value);
    return this.workflowSession.getSurface(runId);
  }

  async getPlan({ runId, query = {} }) {
    return projectPlanResource(await this.requireSession(runId), query);
  }

  async getDiff({ runId, query = {} }) {
    const session = await this.requireSession(runId);
    const item = assertManifestDiffPath(session, query.path);
    const legacy = await this.loadLegacyRun(runId);
    const diff = legacy?.patch
      ? await loadStoredFileDiff(legacy, item.path)
      : await loadPlanItemDiff(item);
    return projectDiffResource(session, { ...query, diff });
  }

  async getOutput({ runId, query = {} }) {
    return projectOutputResource(await this.requireSession(runId), query);
  }

  async getReport(value) {
    const runId = resourceRunId(value);
    const session = await this.requireSession(runId);
    return projectReportResource(session, { legacyRun: await this.loadLegacyRun(runId) });
  }

  async getHistory({ projectId, query = {} }) {
    await this.requireProject(projectId);
    return projectHistoryResource(await this.sessions.list({ projectId }), { projectId, ...query });
  }

  async reconcileOperation(operation) {
    const session = operation.runId ? await this.sessions.get(operation.runId) : null;
    if (!session || terminalRunStatus(session.run.status)) return { settlement: 'uncertain' };
    const snapshot = {
      ...session.publicSummary,
      run: { ...session.publicSummary.run, status: 'uncertain', attention: 'error' },
      operation: { id: operation.operationId, kind: operation.kind, settlement: 'uncertain' },
      error: {
        code: 'OPERATION_OUTCOME_UNCERTAIN',
        message: 'The server restarted before the operation outcome was durably confirmed.',
        retryable: false,
      },
    };
    const updated = await this.sessions.update({
      runId: operation.runId,
      expectedRevision: session.revision,
      changes: { status: 'uncertain', operationId: null, publicSummary: snapshot },
    });
    await this.journal.append('surface.changed', {
      projectId: session.binding.projectId,
      runId: operation.runId,
      operationId: operation.operationId,
      revision: updated.revision,
      data: { kind: 'error' },
    });
    await this.journal.append('run.failed', {
      projectId: session.binding.projectId,
      runId: operation.runId,
      operationId: operation.operationId,
      revision: updated.revision,
      data: { uncertain: true },
    });
    return { settlement: 'uncertain' };
  }

  async reconcileReceipt(record) {
    if (!START_KINDS.has(record.metadata?.kind)) return null;
    const session = await this.sessions.get(record.metadata.runId);
    if (!session || session.binding.projectId !== record.metadata.projectId) {
      return { status: 'uncertain', receipt: null };
    }
    const operations = await this.operations.list({ projectId: session.binding.projectId });
    const operation = operations.find((candidate) => candidate.runId === session.run.runId);
    if (!operation) return { status: 'uncertain', receipt: null };
    return { status: 'completed', receipt: startResponse(session.run.runId, operation.operationId) };
  }

  async waitForIdle() {
    await Promise.allSettled([...this.background]);
  }

  launch(request) {
    let task;
    task = this.operationRunner.run(request)
      .catch((error) => this.onError(error))
      .finally(() => this.background.delete(task));
    this.background.add(task);
  }

  async replayStartClaim(claim) {
    if (claim.kind === 'claimed') return null;
    if (claim.kind === 'replay' && claim.receipt) return claim.receipt;
    throw serviceError('The idempotent run start has not reached a replayable settlement.',
      claim.kind === 'in-progress' ? 'OPERATION_BUSY' : 'IDEMPOTENCY_CONFLICT', 409);
  }

  async loadStartContext(projectId, { blobId = null } = {}) {
    const project = await this.requireProject(projectId);
    const [workflowResource, discovered, blob] = await Promise.all([
      this.workflows.get(project),
      this.inspectProject(project.canonicalPath),
      blobId ? this.blobs.get(blobId) : null,
    ]);
    if (!workflowResource.workflow) {
      throw serviceError('A configured workflow is required.', 'ACTION_NOT_AVAILABLE', 409);
    }
    if (blobId && !blob) throw serviceError('The uploaded archive blob was not found.', 'ACTION_INPUT_INVALID', 404);
    return {
      project,
      discovered: { ...discovered, projectId },
      workflow: workflowResource.workflow,
      workflowRevision: workflowResource.revision,
      blob,
    };
  }

  async assertProjectAvailable(projectId) {
    if (!await projectAcceptsNewRun({
      sessions: this.sessions, operations: this.operations, projectId,
    })) {
      throw serviceError('The project already has an active run.', 'OPERATION_BUSY', 409);
    }
  }

  async requireProject(projectId) {
    const project = await this.projects.get(projectId);
    if (!project) throw serviceError('Project was not found.', 'PROJECT_NOT_FOUND', 404);
    return project;
  }

  async requireSession(runId) {
    const session = await this.sessions.get(runId);
    if (!session) throw serviceError('Run was not found.', 'RUN_NOT_FOUND', 404);
    return session;
  }
}

function archiveRequest(value) {
  const body = object(value, 'Archive run request');
  assertKnownKeys(body, ['kind', 'blobId', 'seriesId', 'correlation'], 'Archive run request');
  if (body.kind !== 'archive' || typeof body.blobId !== 'string') {
    throw serviceError('kind=archive and blobId are required.', 'ACTION_INPUT_INVALID', 400);
  }
  return {
    kind: 'archive', blobId: body.blobId,
    seriesId: nullableId(body.seriesId, 'seriesId'),
    correlation: correlation(body.correlation),
  };
}

function checkRequest(value) {
  const body = object(value, 'Check run request');
  assertKnownKeys(body, ['seriesId', 'checkIds'], 'Check run request');
  return {
    seriesId: nullableId(body.seriesId, 'seriesId'),
    checkIds: body.checkIds == null ? null : uniqueIds(body.checkIds, 'checkIds'),
  };
}

function validateCheckIds(workflow, requested) {
  const selected = new Set((workflow.checks ?? []).filter((check) => check.selected).map((check) => check.id));
  const checkIds = requested ?? [...selected];
  const unknown = checkIds.filter((id) => !selected.has(id));
  if (unknown.length) throw serviceError('Requested checks are not selected in the workflow.', 'ACTION_INPUT_INVALID', 400, { unknownCheckIds: unknown });
  return checkIds;
}

function binding(context, runId) {
  return {
    projectId: context.project.projectId,
    projectPath: context.project.canonicalPath,
    workflowRevision: context.workflowRevision,
    blobId: context.blob?.blobId ?? null,
    blobSha256: context.blob?.sha256 ?? null,
  };
}

function archivePrivateState(context, runId) {
  return {
    version: 1,
    binding: {
      runId, projectId: context.project.projectId, projectPath: context.project.canonicalPath,
      workflowRevision: context.workflowRevision,
      blob: { ...context.blob },
    },
    workflow: structuredClone(context.workflow),
  };
}

function checkPrivateState(context, runId, checkIds) {
  return {
    version: 1,
    binding: {
      runId, projectId: context.project.projectId, projectPath: context.project.canonicalPath,
      workflowRevision: context.workflowRevision,
    },
    workflow: structuredClone(context.workflow),
    selectedCheckIds: [...checkIds],
    applied: { paths: [], changedPaths: [] },
  };
}

function initialSnapshot(context, runId, operationId, kind, status) {
  return {
    project: { id: context.project.projectId, name: context.discovered.name },
    workflow: {
      configured: true,
      revision: context.workflowRevision,
      name: context.workflow.name,
      deployment: {
        configured: deploymentAvailable(context.workflow),
        label: deploymentAvailable(context.workflow) ? 'Configured deployment' : 'Deployment disabled',
      },
    },
    run: { id: runId, status, attention: null, backupAvailable: false },
    operation: { id: operationId, kind, settlement: 'active', phase: kind, cancellable: true },
  };
}

function startResponse(runId, operationId) {
  return {
    status: 202,
    body: {
      runId, operationId, status: 'running',
      links: {
        run: `/v1/runs/${encodeURIComponent(runId)}`,
        operation: `/v1/operations/${encodeURIComponent(operationId)}`,
        events: `/v1/events?runId=${encodeURIComponent(runId)}`,
      },
    },
  };
}

function eventFields(context, runId, operationId, revision) {
  return {
    projectId: context.project.projectId, runId, operationId, revision,
    data: { kind: 'operation_progress' },
  };
}

function correlation(value) {
  if (value == null) return null;
  const source = object(value, 'correlation');
  assertKnownKeys(source, ['producer', 'workflowId', 'requestId'], 'correlation');
  const result = {};
  for (const key of ['producer', 'workflowId', 'requestId']) {
    if (source[key] !== undefined) result[key] = requiredId(source[key], `correlation.${key}`);
  }
  return result;
}

function uniqueIds(value, name) {
  if (!Array.isArray(value)) throw serviceError(`${name} must be an array.`, 'ACTION_INPUT_INVALID', 400);
  return [...new Set(value.map((item) => requiredId(item, name)))];
}

function nullableId(value, name) {
  return value == null ? null : requiredId(value, name);
}

function requiredId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw serviceError(`${name} is invalid.`, 'ACTION_INPUT_INVALID', 400);
  }
  return value;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(`${name} must be an object.`, 'ACTION_INPUT_INVALID', 400);
  }
  return value;
}

function assertKnownKeys(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw serviceError(`${name} contains unsupported fields.`, 'ACTION_INPUT_INVALID', 400, {
      unknownFields: unknown,
    });
  }
}

function quoteRevision(value) {
  return `"${value}"`;
}

function resourceRunId(value) {
  return typeof value === 'string' ? value : value?.runId;
}

function serviceError(message, code, status, details = {}) {
  return Object.assign(new Error(message), {
    code, status, expose: status < 500, detail: message, details,
  });
}
