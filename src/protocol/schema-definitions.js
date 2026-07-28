import {
  ACTION_CONFIRMATIONS,
  ACTION_PRESENTATION_ROLES,
  ACTION_RISKS,
  API_VERSION,
  ERROR_CODES,
  EVENT_TYPES,
  SCHEMA_REVISION,
  SECTION_KINDS,
  SURFACE_KINDS,
} from './constants.js';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const BASE = 'https://zipflow.dev/schemas/v1';
const identifier = { type: 'string', minLength: 1, maxLength: 512 };
const nullableIdentifier = { anyOf: [identifier, { type: 'null' }] };

const action = {
  $schema: DRAFT,
  $id: `${BASE}/action.json`,
  'title': 'Zipflow semantic action',
  type: 'object',
  required: [
    'id', 'kind', 'label', 'description', 'enabled', 'disabledReason',
    'risk', 'confirmation', 'inputSchema', 'presentation',
  ],
  properties: {
    id: identifier,
    kind: identifier,
    label: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    enabled: { type: 'boolean' },
    disabledReason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    risk: { enum: ACTION_RISKS },
    confirmation: { enum: ACTION_CONFIRMATIONS },
    inputSchema: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    presentation: {
      type: 'object',
      required: ['role'],
      properties: { role: { enum: ACTION_PRESENTATION_ROLES } },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};

const section = {
  $schema: DRAFT,
  $id: `${BASE}/section.json`,
  'title': 'Zipflow semantic surface section',
  type: 'object',
  required: ['id', 'kind'],
  properties: {
    id: identifier,
    kind: { enum: SECTION_KINDS },
  },
  additionalProperties: true,
};

const surface = {
  $schema: DRAFT,
  $id: `${BASE}/surface.json`,
  'title': 'Zipflow semantic surface',
  type: 'object',
  required: ['id', 'kind', 'revision', 'title', 'summary', 'stage', 'sections', 'actions', 'links'],
  properties: {
    id: identifier,
    kind: { enum: SURFACE_KINDS },
    revision: { type: 'integer', minimum: 0 },
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string' },
    stage: {
      type: 'object',
      required: ['id', 'index', 'count'],
      properties: {
        id: identifier,
        index: { type: 'integer', minimum: 0 },
        count: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    sections: { type: 'array', items: { $ref: section.$id } },
    actions: { type: 'array', items: { $ref: action.$id } },
    links: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
  },
  additionalProperties: true,
};

const hello = {
  $schema: DRAFT,
  $id: `${BASE}/hello.json`,
  'title': 'Zipflow hello response',
  type: 'object',
  required: ['apiVersion', 'schemaRevision', 'serverEpoch', 'server', 'capabilities', 'links'],
  properties: {
    apiVersion: { const: API_VERSION },
    schemaRevision: { const: SCHEMA_REVISION },
    serverEpoch: identifier,
    server: {
      type: 'object',
      required: ['name', 'version', 'platform'],
      properties: {
        name: { const: 'zipflow' },
        version: { type: 'string', minLength: 1 },
        platform: { type: 'string', minLength: 1 },
      },
      additionalProperties: true,
    },
    capabilities: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: identifier,
    },
    links: {
      type: 'object',
      required: ['openapi', 'schemas'],
      properties: {
        openapi: { const: '/v1/openapi.json' },
        schemas: { const: '/v1/schemas' },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};

const problem = {
  $schema: DRAFT,
  $id: `${BASE}/problem.json`,
  'title': 'Zipflow problem response',
  type: 'object',
  required: ['type', 'title', 'status', 'code', 'message', 'retryable', 'details', 'recoveryAction'],
  properties: {
    type: { type: 'string', pattern: '^https://zipflow\\.dev/problems/' },
    title: { type: 'string', minLength: 1 },
    status: { type: 'integer', minimum: 100, maximum: 599 },
    code: { enum: ERROR_CODES },
    message: { type: 'string', minLength: 1 },
    retryable: { type: 'boolean' },
    details: { type: 'object' },
    recoveryAction: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
  },
  additionalProperties: false,
};

const event = {
  $schema: DRAFT,
  $id: `${BASE}/event.json`,
  'title': 'Zipflow event',
  type: 'object',
  required: [
    'type', 'serverEpoch', 'sequence', 'projectId', 'runId',
    'operationId', 'revision', 'data',
  ],
  properties: {
    type: { enum: EVENT_TYPES },
    serverEpoch: identifier,
    sequence: { type: 'integer', minimum: 0 },
    projectId: nullableIdentifier,
    runId: nullableIdentifier,
    operationId: nullableIdentifier,
    revision: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    data: { type: 'object' },
  },
  additionalProperties: true,
};

const conformance = {
  $schema: DRAFT,
  $id: `${BASE}/conformance.json`,
  'title': 'Zipflow protocol conformance fixture bundle',
  type: 'object',
  required: ['version', 'apiVersion', 'schemaRevision', 'hello', 'surfaces', 'problems', 'sse', 'scenarios'],
  properties: {
    version: { const: 1 },
    apiVersion: { const: API_VERSION },
    schemaRevision: { const: SCHEMA_REVISION },
    hello: { $ref: hello.$id },
    surfaces: { type: 'array', minItems: 1, items: { $ref: surface.$id } },
    problems: { type: 'array', minItems: 1, items: { $ref: problem.$id } },
    sse: {
      type: 'object',
      required: ['replay', 'gap'],
      properties: {
        replay: { type: 'array', minItems: 1, items: { $ref: event.$id } },
        gap: { $ref: event.$id },
      },
      additionalProperties: false,
    },
    scenarios: {
      type: 'object',
      required: ['archiveRun', 'conflictRun', 'failedCheckRun', 'rollback'],
      properties: {
        archiveRun: { type: 'object' },
        conflictRun: { type: 'object' },
        failedCheckRun: { type: 'object' },
        rollback: { type: 'object' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const SCHEMA_DOCUMENTS = deepFreeze({
  action,
  section,
  surface,
  hello,
  problem,
  event,
  conformance,
});

export const SCHEMA_IDS = deepFreeze(Object.fromEntries(
  Object.entries(SCHEMA_DOCUMENTS).map(([name, schema]) => [schema.$id, name]),
));

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
