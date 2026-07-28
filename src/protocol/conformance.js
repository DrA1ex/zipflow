import {
  ACTION_CONFIRMATIONS,
  ACTION_PRESENTATION_ROLES,
  ACTION_RISKS,
  API_VERSION,
  CAPABILITIES,
  ERROR_CODES,
  EVENT_TYPES,
  SCHEMA_REVISION,
  SECTION_KINDS,
  SURFACE_KINDS,
} from './constants.js';
import { createProblem } from './errors.js';
import { ZIPFLOW_VERSION } from '../version.js';

const hello = {
  apiVersion: API_VERSION,
  schemaRevision: SCHEMA_REVISION,
  serverEpoch: 'conformance-epoch-1',
  server: { name: 'zipflow', version: ZIPFLOW_VERSION, platform: 'conformance' },
  capabilities: [...CAPABILITIES],
  links: { openapi: '/v1/openapi.json', schemas: '/v1/schemas' },
};

const surfaces = SURFACE_KINDS.map((kind, index) => ({
  id: `surface-${kind}`,
  kind,
  revision: index + 1,
  title: titleFor(kind),
  summary: `Conformance fixture for ${kind}.`,
  stage: { id: stageFor(kind), index: index + 1, count: SURFACE_KINDS.length },
  sections: [sectionFixture(SECTION_KINDS[index % SECTION_KINDS.length], index)],
  actions: [actionFixture(kind, index)],
  links: { self: `/v1/runs/conformance-run/surface?fixture=${encodeURIComponent(kind)}` },
}));

const replayEvents = EVENT_TYPES.filter((type) => type !== 'stream.gap').map((type, index) => ({
  type,
  serverEpoch: hello.serverEpoch,
  sequence: index + 101,
  projectId: type === 'server.stopping' ? null : 'project-conformance',
  runId: type.startsWith('project.') || type.startsWith('workflow.') || type === 'server.stopping'
    ? null
    : 'run-conformance',
  operationId: type.startsWith('operation.') ? 'operation-conformance' : null,
  revision: type === 'server.stopping' ? null : index + 1,
  data: type === 'operation.progress'
    ? { phase: 'checks', completed: 2, total: 4 }
    : { fixture: type },
}));

const gapEvent = {
  type: 'stream.gap',
  serverEpoch: hello.serverEpoch,
  sequence: replayEvents.at(-1).sequence + 1,
  projectId: 'project-conformance',
  runId: 'run-conformance',
  operationId: null,
  revision: null,
  data: { requestedAfter: 12, retainedFrom: 84 },
};

const bundle = deepFreeze({
  version: 1,
  apiVersion: API_VERSION,
  schemaRevision: SCHEMA_REVISION,
  hello,
  surfaces,
  problems: ERROR_CODES.map((code) => createProblem(code, { message: `Conformance fixture for ${code}.` })),
  sse: { replay: replayEvents, gap: gapEvent },
  scenarios: {
    archiveRun: scenario('archive', 'completed', 'completed'),
    conflictRun: scenario('archive', 'waiting_action', 'conflict_summary'),
    failedCheckRun: scenario('check', 'failed', 'checks_failed'),
    rollback: scenario('rollback', 'rolled_back', 'completed'),
  },
});

const namedFixtures = Object.freeze({
  hello: () => bundle.hello,
  surfaces: () => bundle.surfaces,
  problems: () => bundle.problems,
  sseReplay: () => bundle.sse.replay,
  sseGap: () => bundle.sse.gap,
  archiveRun: () => bundle.scenarios.archiveRun,
  conflictRun: () => bundle.scenarios.conflictRun,
  failedCheckRun: () => bundle.scenarios.failedCheckRun,
  rollback: () => bundle.scenarios.rollback,
});

export const CONFORMANCE_FIXTURE_NAMES = Object.freeze(Object.keys(namedFixtures));

export function listConformanceFixtures() {
  return [...CONFORMANCE_FIXTURE_NAMES];
}

export function getConformanceFixture(name) {
  const accessor = namedFixtures[String(name ?? '')];
  if (!accessor) throw new RangeError(`Unknown Zipflow conformance fixture: ${name}`);
  return structuredClone(accessor());
}

export function getConformanceFixtureBundle() {
  return structuredClone(bundle);
}

export function serializeConformanceFixtures({ space = 2 } = {}) {
  return `${JSON.stringify(bundle, null, space)}\n`;
}

export function formatConformanceSseEvent(event) {
  const { type, ...data } = event;
  return `id: ${event.sequence}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function actionFixture(kind, index) {
  return {
    id: `action-${kind}`,
    kind: `fixture_${kind}`,
    label: `Continue from ${titleFor(kind)}`,
    'description': 'Conformance-only semantic action.',
    enabled: true,
    disabledReason: null,
    risk: ACTION_RISKS[index % ACTION_RISKS.length],
    confirmation: ACTION_CONFIRMATIONS[index % ACTION_CONFIRMATIONS.length],
    inputSchema: null,
    presentation: { role: ACTION_PRESENTATION_ROLES[index % ACTION_PRESENTATION_ROLES.length] },
  };
}

function sectionFixture(kind, index) {
  const base = { id: `section-${kind}`, kind };
  if (kind === 'text') return { ...base, text: 'Conformance text.' };
  if (kind === 'progress') return { ...base, completed: 2, total: 4, phase: 'checks' };
  if (kind === 'choice_list') return { ...base, choices: [{ id: 'choice-1', label: 'Choice' }] };
  if (kind === 'summary_fields') return { ...base, fields: [{ label: 'Files', value: '3' }] };
  if (kind === 'warning_list') return { ...base, warnings: [{ code: 'fixture', message: 'Review this item.' }] };
  return { ...base, fixtureIndex: index, items: [] };
}

function scenario(kind, status, surfaceKind) {
  return {
    projectId: 'project-conformance',
    runId: `run-${kind}-conformance`,
    operationId: `operation-${kind}-conformance`,
    kind,
    status,
    surface: surfaces.find((candidate) => candidate.kind === surfaceKind),
  };
}

function stageFor(kind) {
  if (kind.includes('plan') || kind.includes('conflict') || kind.includes('archive')) return 'review';
  if (kind.includes('check')) return 'checks';
  if (kind.includes('commit')) return 'commit';
  if (kind.includes('deploy')) return 'deploy';
  return 'workflow';
}

function titleFor(kind) {
  return kind.split('_').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
