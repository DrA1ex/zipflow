import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ACTION_CONFIRMATIONS,
  ACTION_RISKS,
  API_VERSION,
  CAPABILITIES,
  ERROR_CODES,
  EVENT_TYPES,
  SCHEMA_REVISION,
  SECTION_KINDS,
  SURFACE_KINDS,
  assertOpenApiDocument,
  assertProtocolValue,
  createProblem,
  getConformanceFixture,
  getConformanceFixtureBundle,
  getOpenApiDocument,
  getProtocolSchema,
  listConformanceFixtures,
  listProtocolSchemas,
  validateProtocolValue,
} from 'zipflow/protocol';

test('protocol v1 constants expose the implementation specification vocabulary', () => {
  assert.equal(API_VERSION, '1.0');
  assert.equal(SCHEMA_REVISION, 1);
  assert.deepEqual(CAPABILITIES, [
    'projects', 'workflow_config', 'blobs', 'archive_runs', 'check_runs',
    'semantic_surfaces', 'actions', 'plans', 'diffs', 'history', 'rollback', 'events',
  ]);
  assert.deepEqual(ERROR_CODES, [
    'AUTH_REQUIRED', 'API_INCOMPATIBLE', 'CAPABILITY_MISSING', 'PROJECT_NOT_FOUND',
    'RUN_NOT_FOUND', 'OPERATION_NOT_FOUND', 'STALE_REVISION', 'ACTION_NOT_AVAILABLE',
    'ACTION_INPUT_INVALID', 'IDEMPOTENCY_REQUIRED', 'IDEMPOTENCY_CONFLICT',
    'OPERATION_BUSY', 'UNSAFE_ARCHIVE', 'ARCHIVE_LIMIT_EXCEEDED', 'CANCEL_DEFERRED',
    'STREAM_GAP', 'INTERNAL_ERROR',
  ]);
  assert.equal(EVENT_TYPES.includes('stream.gap'), true);
});

test('schema accessors return isolated checked-in runtime documents', () => {
  const descriptors = listProtocolSchemas();
  assert.deepEqual(descriptors.map((entry) => entry.name), [
    'action', 'section', 'surface', 'hello', 'problem', 'event', 'conformance',
  ]);
  for (const { name, id, path } of descriptors) {
    const schema = getProtocolSchema(name);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.$id, id);
    assert.equal(path, `/v1/schemas/${name}`);
  }
  const first = getProtocolSchema('hello');
  first.title = 'mutated consumer copy';
  assert.equal(getProtocolSchema('hello').title, 'Zipflow hello response');
  assert.throws(() => getProtocolSchema('missing'), /Unknown Zipflow protocol schema/);
});

test('conformance bundle validates and covers every required stable discriminant', () => {
  const bundle = getConformanceFixtureBundle();
  assert.equal(assertProtocolValue('conformance', bundle), bundle);
  assertProtocolValue('hello', bundle.hello);
  bundle.surfaces.forEach((surface) => assertProtocolValue('surface', surface));
  bundle.problems.forEach((problem) => assertProtocolValue('problem', problem));
  bundle.sse.replay.forEach((event) => assertProtocolValue('event', event));
  assertProtocolValue('event', bundle.sse.gap);

  assert.deepEqual(new Set(bundle.surfaces.map((surface) => surface.kind)), new Set(SURFACE_KINDS));
  assert.deepEqual(new Set(bundle.surfaces.flatMap((surface) => surface.sections.map((item) => item.kind))), new Set(SECTION_KINDS));
  assert.deepEqual(new Set(bundle.surfaces.flatMap((surface) => surface.actions.map((item) => item.risk))), new Set(ACTION_RISKS));
  assert.deepEqual(new Set(bundle.surfaces.flatMap((surface) => surface.actions.map((item) => item.confirmation))), new Set(ACTION_CONFIRMATIONS));
  assert.deepEqual(new Set(bundle.problems.map((problem) => problem.code)), new Set(ERROR_CODES));
  assert.deepEqual(listConformanceFixtures(), [
    'hello', 'surfaces', 'problems', 'sseReplay', 'sseGap',
    'archiveRun', 'conflictRun', 'failedCheckRun', 'rollback',
  ]);
  assert.equal(getConformanceFixture('sseGap').type, 'stream.gap');
});

test('runtime validation rejects drifted fixtures with a precise property path', () => {
  const hello = getConformanceFixture('hello');
  hello.schemaRevision = 2;
  const result = validateProtocolValue('hello', hello);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.path === '$.schemaRevision'), true);
  assert.throws(() => assertProtocolValue('hello', hello), /schemaRevision/);
});

test('OpenAPI uses authenticated local transport semantics and the runtime schemas', () => {
  const document = getOpenApiDocument();
  assert.equal(assertOpenApiDocument(document), document);
  assert.deepEqual(document.security, [{ bearerAuth: [] }]);
  assert.ok(document.paths['/v1/hello']?.get);
  assert.ok(document.paths['/v1/events']?.get);
  assert.ok(document.paths['/v1/runs/{runId}/actions/{actionId}']?.post);
  assert.deepEqual(document.components.schemas.hello, getProtocolSchema('hello'));
  assert.equal(document.paths['/v1/events'].get.responses[200].content['text/event-stream'].schema.type, 'string');

  const replacement = document.paths['/v1/projects/{projectId}/workflow'].put;
  assert.equal(replacement.parameters.some((item) => item.$ref?.endsWith('/IdempotencyKey')), true);
  assert.equal(replacement.parameters.some((item) => item.$ref?.endsWith('/IfMatch')), true);
  for (const [pathName, method] of [
    ['/v1/projects/open', 'post'],
    ['/v1/projects/{projectId}/workflow', 'put'],
    ['/v1/blobs', 'post'],
    ['/v1/projects/{projectId}/runs', 'post'],
    ['/v1/projects/{projectId}/check-runs', 'post'],
    ['/v1/operations/{operationId}/cancel', 'post'],
    ['/v1/runs/{runId}/actions/{actionId}', 'post'],
  ]) {
    assert.equal(document.paths[pathName][method].parameters.some(
      (item) => item.$ref === '#/components/parameters/IdempotencyKey',
    ), true, `${method.toUpperCase()} ${pathName} must require Idempotency-Key`);
  }
  document.info.title = 'consumer copy';
  assert.notEqual(getOpenApiDocument().info.title, 'consumer copy');
});

test('stable problems are schema-valid and package exports do not bump the feature version', async () => {
  for (const code of ERROR_CODES) assertProtocolValue('problem', createProblem(code));
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.version, '1.8.3');
  assert.deepEqual(packageJson.exports, {
    '.': './src/index.js',
    './client': './src/client/index.js',
    './protocol': './src/protocol/index.js',
  });
});
