import {
  API_VERSION,
  CAPABILITIES,
  getOpenApiDocument,
  getProtocolSchema,
  getProtocolSchemasDocument,
  PROTOCOL_MEDIA_TYPES,
  PROTOCOL_PATHS,
  SCHEMA_REVISION,
} from '../protocol/index.js';
import { ZIPFLOW_VERSION } from '../version.js';
import { discoverProject } from '../project/detect.js';
import { loadWorkflow } from '../workflow/store.js';
import { projectIdForCanonicalPath } from './project-registry.js';
import { fingerprintRequest } from './idempotency-store.js';
import { ServerHttpError } from './router.js';
import {
  parseRevisionEtag,
  workflowSemanticFingerprint,
  workflowEtag,
} from '../application/workflow-resource-store.js';
import { createServerProblem } from './problems.js';

export function registerInfrastructureRoutes(router, services) {
  const {
    lifecycle,
    projects,
    blobs,
    idempotency,
    operations,
    journal,
    sse,
    workflows,
    inspectProject = discoverProject,
    workflowSummary = readWorkflowSummary,
    acceptingMutations = () => true,
  } = services;

  router.get(PROTOCOL_PATHS.hello, async () => ({
    apiVersion: API_VERSION,
    schemaRevision: SCHEMA_REVISION,
    serverEpoch: lifecycle.serverEpoch,
    server: {
      name: 'zipflow',
      version: ZIPFLOW_VERSION,
      platform: process.platform,
    },
    capabilities: [...CAPABILITIES],
    links: {
      openapi: PROTOCOL_PATHS.openapi,
      schemas: PROTOCOL_PATHS.schemas,
    },
  }));

  router.get(PROTOCOL_PATHS.openapi, async () => getOpenApiDocument());
  router.get(PROTOCOL_PATHS.schemas, async () => getProtocolSchemasDocument());
  router.get(`${PROTOCOL_PATHS.schemas}/:name`, async ({ params }) => {
    try {
      return getProtocolSchema(params.name);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ServerHttpError(404, 'ACTION_INPUT_INVALID', 'Protocol schema was not found.');
      }
      throw error;
    }
  });

  router.post('/v1/projects/open', async ({ body, idempotencyKey }) => {
    assertAccepting(acceptingMutations);
    const draft = requireObject(body);
    if (typeof draft.path !== 'string' || !draft.path) {
      throw new ServerHttpError(400, 'ACTION_INPUT_INVALID', 'Project path is required.');
    }
    const discovered = await inspectProject(draft.path);
    const metadata = projectMetadata(discovered);
    const canonicalPath = discovered.root;
    const projectId = projectIdForCanonicalPath(canonicalPath);
    const fingerprint = fingerprintRequest({
      method: 'POST',
      path: '/v1/projects/open',
      body: { path: canonicalPath, client: draft.client ?? null },
    });
    const claim = await idempotency.claim({
      key: idempotencyKey,
      fingerprint,
      metadata: { kind: 'project-open', projectId, canonicalPath },
    });
    const replay = replayOrThrow(claim);
    if (replay) return replay;

    try {
      const existing = await projects.get(projectId);
      const project = await projects.open(canonicalPath, metadata);
      const result = {
        status: 200,
        body: await projectResponse(project, { operations, workflows, workflowSummary }),
      };
      if (!existing) {
        await journal.append('project.changed', {
          projectId: project.projectId,
          revision: project.revision,
          data: { change: 'opened' },
        });
      }
      await idempotency.complete({ key: idempotencyKey, fingerprint, receipt: result });
      return result;
    } catch (error) {
      await idempotency.markUncertain({ key: idempotencyKey, fingerprint }).catch(() => {});
      throw error;
    }
  }, { body: 'json', idempotency: true });

  router.get('/v1/projects/:projectId', async ({ params }) => {
    const project = await projects.get(params.projectId);
    if (!project) throw new ServerHttpError(404, 'PROJECT_NOT_FOUND', 'Project was not found.');
    return projectResponse(project, { operations, workflows, workflowSummary });
  });

  router.get('/v1/projects/:projectId/workflow', async ({ params }) => {
    const project = await requireProject(projects, params.projectId);
    const current = await workflows.get(project);
    return workflowResponse(project, current);
  });

  router.put('/v1/projects/:projectId/workflow', async ({
    request,
    params,
    body,
    idempotencyKey,
  }) => {
    assertAccepting(acceptingMutations);
    const project = await requireProject(projects, params.projectId);
    const expectedRevision = parseRevisionEtag(request.headers['if-match']);
    const draft = requireObject(body);
    const fingerprint = fingerprintRequest({
      method: 'PUT',
      path: `/v1/projects/${project.projectId}/workflow`,
      expectedRevision,
      body: draft,
    });
    const claim = await idempotency.claim({
      key: idempotencyKey,
      fingerprint,
      metadata: {
        kind: 'workflow-put',
        projectId: project.projectId,
        expectedRevision,
        workflowHash: workflowSemanticFingerprint({
          ...draft,
          projectPath: project.canonicalPath,
        }),
      },
    });
    const replay = replayOrThrow(claim);
    if (replay) return replay;

    try {
      const current = await workflows.replace({ project, draft, expectedRevision });
      const result = workflowResponse(project, current);
      await journal.append('workflow.changed', {
        projectId: project.projectId,
        revision: current.revision,
        data: { workflowRevision: current.revision },
      });
      await idempotency.complete({ key: idempotencyKey, fingerprint, receipt: result });
      return result;
    } catch (error) {
      if (error?.expose && Number.isInteger(error.status) && error.status < 500) {
        const result = {
          status: error.status,
          headers: { 'content-type': 'application/problem+json; charset=utf-8' },
          body: createServerProblem({
            status: error.status,
            code: error.code,
            detail: error.detail ?? error.message,
            details: error.details,
          }),
        };
        await idempotency.fail({ key: idempotencyKey, fingerprint, receipt: result });
        return result;
      }
      await idempotency.markUncertain({ key: idempotencyKey, fingerprint }).catch(() => {});
      throw error;
    }
  }, { body: 'json', idempotency: true });

  router.post('/v1/blobs', async ({ request, idempotencyKey }) => {
    assertAccepting(acceptingMutations);
    requireMediaType(request, PROTOCOL_MEDIA_TYPES.zip);
    const contentLength = requireContentLength(request.headers['content-length']);
    const filename = requireHeader(request.headers['x-zipflow-filename'], 'X-Zipflow-Filename');
    const staged = await blobs.stageStream(request, {
      contentLength,
      filename,
    });
    const fingerprint = fingerprintRequest({
      method: 'POST',
      path: '/v1/blobs',
      body: {
        blobId: staged.blobId,
        size: staged.size,
        filename: staged.filename,
      },
    });
    try {
      const claim = await idempotency.claim({
        key: idempotencyKey,
        fingerprint,
        metadata: {
          kind: 'blob-upload',
          blobId: staged.blobId,
          sha256: staged.sha256,
          size: staged.size,
          filename: staged.filename,
        },
      });
      const replay = replayOrThrow(claim);
      if (replay) return replay;
      try {
        const stored = await staged.publish();
        const result = { status: 200, body: blobResponse(stored) };
        await idempotency.complete({ key: idempotencyKey, fingerprint, receipt: result });
        return result;
      } catch (error) {
        await idempotency.markUncertain({ key: idempotencyKey, fingerprint }).catch(() => {});
        throw error;
      }
    } finally {
      await staged.discard();
    }
  }, { idempotency: true });

  router.get('/v1/operations/:operationId', async ({ params }) => {
    const operation = await operations.get(params.operationId);
    if (!operation) throw new ServerHttpError(404, 'OPERATION_NOT_FOUND', 'Operation was not found.');
    return operation;
  });

  router.post('/v1/operations/:operationId/cancel', async ({ params, idempotencyKey }) => {
    assertAccepting(acceptingMutations);
    const fingerprint = fingerprintRequest({
      method: 'POST',
      path: `/v1/operations/${params.operationId}/cancel`,
    });
    const claim = await idempotency.claim({
      key: idempotencyKey,
      fingerprint,
      operationId: params.operationId,
      metadata: { kind: 'operation-cancel', operationId: params.operationId },
    });
    const replay = replayOrThrow(claim);
    if (replay) return replay;
    try {
      const cancelled = await operations.requestCancellation(params.operationId);
      const result = { status: cancelled.status, body: cancelled.operation };
      await idempotency.complete({ key: idempotencyKey, fingerprint, receipt: result });
      return result;
    } catch (error) {
      await idempotency.markUncertain({ key: idempotencyKey, fingerprint }).catch(() => {});
      throw error;
    }
  }, { idempotency: true });

  router.get(PROTOCOL_PATHS.events, (context) => sse.open(context));
  return router;
}

export async function reconcileInfrastructureReceipt(record, services) {
  const metadata = record.metadata;
  if (metadata?.kind === 'blob-upload') {
    const blob = await services.blobs.get(metadata.blobId);
    return blob
      ? { status: 'completed', receipt: { status: 200, body: blobResponse(blob) } }
      : { status: 'uncertain', receipt: null };
  }
  if (metadata?.kind === 'project-open') {
    const project = await services.projects.get(metadata.projectId);
    if (!project) return { status: 'uncertain', receipt: null };
    await services.journal.append('project.changed', {
      projectId: project.projectId,
      revision: project.revision,
      data: { change: 'reconciled' },
    });
    return {
      status: 'completed',
      receipt: {
        status: 200,
        body: await projectResponse(project, services),
      },
    };
  }
  if (metadata?.kind === 'operation-cancel') {
    const operation = await services.operations.get(metadata.operationId);
    return operation
      ? {
        status: 'completed',
        receipt: {
          status: ['active', 'cancel_requested', 'cancel_deferred'].includes(operation.settlement) ? 202 : 200,
          body: operation,
        },
      }
      : { status: 'uncertain', receipt: null };
  }
  if (metadata?.kind === 'workflow-put') {
    const project = await services.projects.get(metadata.projectId);
    if (!project || !services.workflows) return { status: 'uncertain', receipt: null };
    const current = await services.workflows.get(project);
    if (
      current.revision !== metadata.expectedRevision + 1
      || workflowSemanticFingerprint(current.workflow) !== metadata.workflowHash
    ) {
      return { status: 'uncertain', receipt: null };
    }
    return {
      status: 'completed',
      receipt: workflowResponse(project, current),
    };
  }
  return { status: 'uncertain', receipt: null };
}

async function projectResponse(project, {
  operations,
  workflows = null,
  workflowSummary = readWorkflowSummary,
}) {
  const [workflow, activeOperations] = await Promise.all([
    workflows
      ? workflows.get(project).then((value) => ({
        workflowConfigured: Boolean(value.workflow),
        workflowRevision: value.revision,
      }))
      : workflowSummary(project.canonicalPath),
    operations.list({ projectId: project.projectId, activeOnly: true }),
  ]);
  return {
    projectId: project.projectId,
    canonicalPath: project.canonicalPath,
    project: project.project,
    workflowConfigured: workflow.workflowConfigured,
    workflowRevision: workflow.workflowRevision,
    activeRunId: activeOperations.find((operation) => operation.runId)?.runId ?? null,
    surface: {},
    activeOperations,
  };
}

async function requireProject(projects, projectId) {
  const project = await projects.get(projectId);
  if (!project) throw new ServerHttpError(404, 'PROJECT_NOT_FOUND', 'Project was not found.');
  return project;
}

function workflowResponse(project, current) {
  return {
    status: 200,
    headers: { etag: workflowEtag(current.revision) },
    body: {
      projectId: project.projectId,
      revision: current.revision,
      workflow: current.workflow,
    },
  };
}

async function readWorkflowSummary(projectPath) {
  const workflow = await loadWorkflow(projectPath);
  return {
    workflowConfigured: Boolean(workflow),
    workflowRevision: workflow?.version ?? null,
  };
}

function projectMetadata(project) {
  return {
    name: project.name,
    technologies: (project.workspaceTechnologies ?? project.technologies ?? [])
      .map((item) => typeof item === 'string' ? item : item?.id)
      .filter(Boolean),
    labels: project.workspaceLabels ?? project.labels ?? [],
  };
}

function blobResponse(blob) {
  return {
    blobId: blob.blobId,
    sha256: blob.sha256,
    size: blob.size,
    filename: blob.filename,
    createdAt: blob.createdAt,
  };
}

function replayOrThrow(claim) {
  if (claim.kind === 'claimed') return null;
  if (claim.kind === 'replay' && claim.receipt) return claim.receipt;
  throw new ServerHttpError(
    409,
    claim.kind === 'in-progress' ? 'OPERATION_BUSY' : 'IDEMPOTENCY_CONFLICT',
    'The idempotent mutation has not reached a replayable settlement.',
  );
}

function assertAccepting(callback) {
  if (callback()) return;
  throw new ServerHttpError(503, 'OPERATION_BUSY', 'The server is stopping.');
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServerHttpError(400, 'ACTION_INPUT_INVALID', 'A JSON object is required.');
  }
  return value;
}

function requireMediaType(request, expected) {
  const mediaType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== expected) {
    throw new ServerHttpError(415, 'ACTION_INPUT_INVALID', `Content-Type must be ${expected}.`);
  }
}

function requireContentLength(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new ServerHttpError(400, 'ACTION_INPUT_INVALID', 'A valid Content-Length is required.');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new ServerHttpError(400, 'ACTION_INPUT_INVALID', 'A valid Content-Length is required.');
  }
  return length;
}

function requireHeader(value, name) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) {
    throw new ServerHttpError(400, 'ACTION_INPUT_INVALID', `${name} is required.`);
  }
  return value;
}
