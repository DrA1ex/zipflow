import { API_VERSION, PROTOCOL_MEDIA_TYPES } from './constants.js';
import { SCHEMA_DOCUMENTS } from './schema-definitions.js';

const jsonResponse = (schema = { type: 'object' }, description = 'Successful response') => ({
  description,
  content: { [PROTOCOL_MEDIA_TYPES.json]: { schema } },
});
const operation = (operationId, summary, responses = { 200: jsonResponse() }, extra = {}) => ({
  operationId,
  summary,
  responses: { ...responses, default: problemResponse() },
  ...extra,
});
const mutation = (operationId, summary, extra = {}) => {
  const { parameters = [], ...operationOptions } = extra;
  return operation(operationId, summary, {
    200: jsonResponse(),
    202: jsonResponse(undefined, 'Operation accepted'),
  }, {
    ...operationOptions,
    parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }, ...parameters],
  });
};
const pathParameter = (name) => ({ name, in: 'path', required: true, schema: { type: 'string', minLength: 1 } });
const queryParameter = (name) => ({ name, in: 'query', required: false, schema: { type: 'string' } });
const jsonBody = (schema = { type: 'object' }) => ({
  required: true,
  content: { [PROTOCOL_MEDIA_TYPES.json]: { schema } },
});

const paths = {
  '/v1/hello': {
    get: operation('getHello', 'Negotiate the authenticated local API', {
      200: jsonResponse({ $ref: '#/components/schemas/hello' }),
    }),
  },
  '/v1/openapi.json': {
    get: operation('getOpenApi', 'Read this OpenAPI document'),
  },
  '/v1/schemas': {
    get: operation('listSchemas', 'List protocol JSON Schemas'),
  },
  '/v1/schemas/{name}': {
    parameters: [pathParameter('name')],
    get: operation('getSchema', 'Read one protocol JSON Schema'),
  },
  '/v1/projects/open': {
    post: mutation('openProject', 'Open a canonical project session', { requestBody: jsonBody() }),
  },
  '/v1/projects/{projectId}': {
    parameters: [pathParameter('projectId')],
    get: operation('getProject', 'Read a project summary'),
  },
  '/v1/projects/{projectId}/workflow': {
    parameters: [pathParameter('projectId')],
    get: operation('getWorkflow', 'Read workflow configuration'),
    put: mutation('replaceWorkflow', 'Replace workflow configuration', {
      parameters: [{ $ref: '#/components/parameters/IfMatch' }],
      requestBody: jsonBody(),
    }),
  },
  '/v1/blobs': {
    post: mutation('uploadBlob', 'Upload an isolated ZIP blob', {
      parameters: [
        { name: 'X-Zipflow-Filename', in: 'header', required: true, schema: { type: 'string', minLength: 1 } },
      ],
      requestBody: {
        required: true,
        content: { [PROTOCOL_MEDIA_TYPES.zip]: { schema: { type: 'string', format: 'binary' } } },
      },
    }),
  },
  '/v1/projects/{projectId}/runs': {
    parameters: [pathParameter('projectId')],
    post: mutation('startArchiveRun', 'Start an archive run', { requestBody: jsonBody() }),
  },
  '/v1/projects/{projectId}/check-runs': {
    parameters: [pathParameter('projectId')],
    post: mutation('startCheckRun', 'Run configured project checks', { requestBody: jsonBody() }),
  },
  '/v1/projects/{projectId}/deploy-runs': {
    parameters: [pathParameter('projectId')],
    post: mutation('startDeployRun', 'Run the configured project deployment', { requestBody: jsonBody() }),
  },
  '/v1/projects/{projectId}/setup-actions/{actionId}': {
    parameters: [pathParameter('projectId'), pathParameter('actionId')],
    post: mutation('performProjectSetupAction', 'Perform an advertised project setup mutation', { requestBody: jsonBody() }),
  },
  '/v1/runs/{runId}': {
    parameters: [pathParameter('runId')],
    get: operation('getRun', 'Read a run'),
  },
  '/v1/operations/{operationId}': {
    parameters: [pathParameter('operationId')],
    get: operation('getOperation', 'Read an operation'),
  },
  '/v1/operations/{operationId}/cancel': {
    parameters: [pathParameter('operationId')],
    post: mutation('cancelOperation', 'Request operation cancellation'),
  },
  '/v1/runs/{runId}/surface': {
    parameters: [pathParameter('runId')],
    get: operation('getSurface', 'Read the current semantic surface', {
      200: jsonResponse({ $ref: '#/components/schemas/surface' }),
    }),
  },
  '/v1/runs/{runId}/actions/{actionId}': {
    parameters: [pathParameter('runId'), pathParameter('actionId')],
    post: mutation('invokeAction', 'Invoke an advertised semantic action', {
      parameters: [{ $ref: '#/components/parameters/IfMatch' }],
      requestBody: jsonBody(),
    }),
  },
  '/v1/runs/{runId}/plan': {
    parameters: [pathParameter('runId'), queryParameter('group'), queryParameter('cursor'), queryParameter('limit')],
    get: operation('getPlan', 'Read a bounded plan page'),
  },
  '/v1/runs/{runId}/diff': {
    parameters: [pathParameter('runId'), queryParameter('path'), queryParameter('mode')],
    get: operation('getDiff', 'Read a semantic file diff'),
  },
  '/v1/runs/{runId}/output': {
    parameters: [pathParameter('runId'), queryParameter('source'), queryParameter('cursor')],
    get: operation('getOutput', 'Read bounded check or deployment output'),
  },
  '/v1/runs/{runId}/report': {
    parameters: [pathParameter('runId')],
    get: operation('getReport', 'Read a sanitized run report'),
  },
  '/v1/projects/{projectId}/history': {
    parameters: [
      pathParameter('projectId'), queryParameter('cursor'), queryParameter('limit'), queryParameter('status'),
    ],
    get: operation('getHistory', 'Read bounded project history'),
  },
  '/v1/events': {
    get: operation('getEvents', 'Observe and replay project events', {
      200: {
        'description': 'Server-sent event stream',
        content: { [PROTOCOL_MEDIA_TYPES.events]: { schema: { type: 'string' } } },
      },
    }, {
      parameters: [
        queryParameter('projectId'), queryParameter('runId'), queryParameter('operationId'),
        { $ref: '#/components/parameters/LastEventId' },
      ],
    }),
  },
};

const document = deepFreeze({
  openapi: '3.1.0',
  info: {
    'title': 'Zipflow Local Workflow API',
    version: API_VERSION,
    'description': 'Authenticated HTTP/JSON and SSE over a local endpoint. No TCP listener is implied.',
  },
  servers: [{ url: 'http://localhost', 'description': 'Placeholder authority for Unix sockets or Windows named pipes' }],
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key', in: 'header', required: true,
        schema: { type: 'string', minLength: 1, maxLength: 512 },
      },
      IfMatch: {
        name: 'If-Match', in: 'header', required: true,
        schema: { type: 'string', minLength: 1 },
      },
      LastEventId: {
        name: 'Last-Event-ID', in: 'header', required: false,
        schema: { type: 'string', pattern: '^[0-9]+$' },
      },
    },
    schemas: Object.fromEntries(Object.entries(SCHEMA_DOCUMENTS).map(([name, schema]) => [name, schema])),
  },
});

export function getOpenApiDocument() {
  return structuredClone(document);
}

export function validateOpenApiDocument(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('document must be an object');
  if (value?.openapi !== '3.1.0') errors.push('openapi must equal 3.1.0');
  if (value?.info?.version !== API_VERSION) errors.push(`info.version must equal ${API_VERSION}`);
  if (!value?.security?.some((entry) => Object.hasOwn(entry, 'bearerAuth'))) errors.push('bearerAuth security is required');
  for (const requiredPath of Object.keys(paths)) {
    if (!value?.paths?.[requiredPath]) errors.push(`missing path ${requiredPath}`);
  }
  return { valid: errors.length === 0, errors };
}

export function assertOpenApiDocument(value = document) {
  const result = validateOpenApiDocument(value);
  if (!result.valid) throw new TypeError(`Invalid Zipflow OpenAPI document: ${result.errors.join('; ')}`);
  return value;
}

function problemResponse() {
  return {
    'description': 'Zipflow problem response',
    content: { [PROTOCOL_MEDIA_TYPES.problem]: { schema: { $ref: '#/components/schemas/problem' } } },
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
