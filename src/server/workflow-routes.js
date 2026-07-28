import {
  parseRevisionEtag,
  workflowEtag,
} from '../application/workflow-resource-store.js';
import { ServerHttpError } from './router.js';

const APPLICATION_METHODS = Object.freeze([
  'startArchiveRun',
  'startCheckRun',
  'getRun',
  'getSurface',
  'dispatchAction',
  'getPlan',
  'getDiff',
  'getOutput',
  'getReport',
  'getHistory',
]);

const OUTPUT_SOURCES = new Set(['checks', 'deploy']);

export function registerWorkflowRoutes(router, {
  application,
  acceptingMutations = () => true,
} = {}) {
  assertRouter(router);
  assertApplication(application);
  if (typeof acceptingMutations !== 'function') {
    throw new TypeError('acceptingMutations must be a function.');
  }

  router.post('/v1/projects/:projectId/runs', async ({
    params,
    query,
    body,
    idempotencyKey,
  }) => {
    assertAccepting(acceptingMutations);
    requireNoQuery(query);
    const requestBody = requireObject(body, 'Archive run request');
    if (requestBody.kind !== 'archive') {
      throw inputError('Archive run request kind must be archive.');
    }
    return application.startArchiveRun({
      projectId: params.projectId,
      body: requestBody,
      idempotencyKey,
    });
  }, { body: 'json', idempotency: true });

  router.post('/v1/projects/:projectId/check-runs', async ({
    params,
    query,
    body,
    idempotencyKey,
  }) => {
    assertAccepting(acceptingMutations);
    requireNoQuery(query);
    return application.startCheckRun({
      projectId: params.projectId,
      body: requireObject(body, 'Check run request'),
      idempotencyKey,
    });
  }, { body: 'json', idempotency: true });

  router.get('/v1/runs/:runId', async ({ params, query }) => {
    requireNoQuery(query);
    return application.getRun({ runId: params.runId });
  });

  router.get('/v1/runs/:runId/surface', async ({ params, query }) => {
    requireNoQuery(query);
    const result = await application.getSurface({ runId: params.runId });
    return withSurfaceEtag(result);
  });

  router.post('/v1/runs/:runId/actions/:actionId', async ({
    request,
    params,
    query,
    body,
    idempotencyKey,
  }) => {
    assertAccepting(acceptingMutations);
    requireNoQuery(query);
    const requestBody = requireExactActionBody(body);
    return application.dispatchAction({
      runId: params.runId,
      actionId: params.actionId,
      expectedRevision: parseRevisionEtag(request.headers['if-match']),
      input: requestBody.input,
      idempotencyKey,
    });
  }, { body: 'json', idempotency: true });

  router.get('/v1/runs/:runId/plan', async ({ params, query }) => (
    application.getPlan({
      runId: params.runId,
      query: readQuery(query, {
        group: textQuery,
        cursor: cursorQuery,
        limit: limitQuery,
      }),
    })
  ));

  router.get('/v1/runs/:runId/diff', async ({ params, query }) => (
    application.getDiff({
      runId: params.runId,
      query: readQuery(query, {
        path: requiredTextQuery,
        mode: textQuery,
      }, ['path']),
    })
  ));

  router.get('/v1/runs/:runId/output', async ({ params, query }) => (
    application.getOutput({
      runId: params.runId,
      query: readQuery(query, {
        source: outputSourceQuery,
        cursor: cursorQuery,
      }, ['source']),
    })
  ));

  router.get('/v1/runs/:runId/report', async ({ params, query }) => {
    requireNoQuery(query);
    return application.getReport({ runId: params.runId });
  });

  router.get('/v1/projects/:projectId/history', async ({ params, query }) => (
    application.getHistory({
      projectId: params.projectId,
      query: readQuery(query, {
        cursor: cursorQuery,
        limit: limitQuery,
        status: textQuery,
      }),
    })
  ));

  return router;
}

function assertRouter(router) {
  if (!router || typeof router.get !== 'function' || typeof router.post !== 'function') {
    throw new TypeError('Workflow routes require a router with get and post methods.');
  }
}

function assertApplication(application) {
  if (!application || typeof application !== 'object') {
    throw new TypeError('Workflow routes require an application service.');
  }
  for (const method of APPLICATION_METHODS) {
    if (typeof application[method] !== 'function') {
      throw new TypeError(`Workflow application method is required: ${method}`);
    }
  }
}

function assertAccepting(acceptingMutations) {
  if (!acceptingMutations()) {
    throw new ServerHttpError(503, 'OPERATION_BUSY', 'The server is stopping.');
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw inputError(`${name} must be a JSON object.`);
  }
  return value;
}

function requireExactActionBody(value) {
  const body = requireObject(value, 'Action request');
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'input') {
    throw inputError('Action request must contain only an input object.');
  }
  requireObject(body.input, 'Action input');
  return body;
}

function requireNoQuery(query) {
  readQuery(query, {});
}

function readQuery(query, definitions, required = []) {
  const allowed = new Set(Object.keys(definitions));
  for (const name of query.keys()) {
    if (!allowed.has(name)) throw inputError(`Unsupported query parameter: ${name}`);
  }
  const output = {};
  for (const [name, normalize] of Object.entries(definitions)) {
    const values = query.getAll(name);
    if (values.length > 1) throw inputError(`Query parameter ${name} must be a scalar value.`);
    if (values.length === 1) output[name] = normalize(values[0], name);
  }
  for (const name of required) {
    if (!Object.hasOwn(output, name)) throw inputError(`Query parameter ${name} is required.`);
  }
  return output;
}

function textQuery(value, name) {
  return safeQueryText(value, name, 4096);
}

function cursorQuery(value, name) {
  return safeQueryText(value, name, 8192);
}

function requiredTextQuery(value, name) {
  return safeQueryText(value, name, 4096);
}

function outputSourceQuery(value, name) {
  const source = safeQueryText(value, name, 32);
  if (!OUTPUT_SOURCES.has(source)) {
    throw inputError('Query parameter source must be checks or deploy.');
  }
  return source;
}

function safeQueryText(value, name, maxLength) {
  if (typeof value !== 'string' || !value || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw inputError(`Query parameter ${name} must be a non-empty safe string.`);
  }
  return value;
}

function limitQuery(value) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw inputError('Query parameter limit must be a positive safe integer.');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    throw inputError('Query parameter limit must be a positive safe integer.');
  }
  return limit;
}

function withSurfaceEtag(result) {
  if (isRouteEnvelope(result)) {
    return {
      ...result,
      headers: {
        ...(result.headers ?? {}),
        etag: workflowEtag(result.body?.revision),
      },
    };
  }
  return {
    status: 200,
    headers: { etag: workflowEtag(result?.revision) },
    body: result,
  };
}

function isRouteEnvelope(value) {
  return value
    && typeof value === 'object'
    && ('status' in value || 'headers' in value || 'body' in value)
    && Object.keys(value).every((key) => ['status', 'headers', 'body'].includes(key));
}

function inputError(detail) {
  return new ServerHttpError(400, 'ACTION_INPUT_INVALID', detail);
}
