import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServerProblem } from '../src/server/problems.js';
import { LocalHttpRouter } from '../src/server/router.js';
import { registerWorkflowRoutes } from '../src/server/workflow-routes.js';

const NO_BODY = Symbol('no-body');
const APPLICATION_METHODS = [
  'startArchiveRun', 'startCheckRun', 'startDeployRun', 'getRun', 'getSurface', 'dispatchAction',
  'getPlan', 'getDiff', 'getOutput', 'getReport', 'getHistory',
];

test('workflow adapter registers the complete route and middleware contract', () => {
  const fixture = workflowFixture();
  assert.deepEqual(fixture.router.routes.map(({ method, template, options }) => ({
    method,
    template,
    options,
  })), [
    post('/v1/projects/:projectId/runs', true),
    post('/v1/projects/:projectId/check-runs', true),
    post('/v1/projects/:projectId/deploy-runs', true),
    get('/v1/runs/:runId'),
    get('/v1/runs/:runId/surface'),
    post('/v1/runs/:runId/actions/:actionId', true),
    get('/v1/runs/:runId/plan'),
    get('/v1/runs/:runId/diff'),
    get('/v1/runs/:runId/output'),
    get('/v1/runs/:runId/report'),
    get('/v1/projects/:projectId/history'),
  ]);

  assert.throws(
    () => registerWorkflowRoutes({}, { application: fixture.application }),
    /router with get and post methods/,
  );
  const missing = { ...fixture.application };
  delete missing.getHistory;
  assert.throws(
    () => registerWorkflowRoutes(new LocalHttpRouter({ token: 'token' }), { application: missing }),
    /getHistory/,
  );
});

test('workflow mutations delegate exact bodies, revisions, keys, and envelopes', async () => {
  const fixture = workflowFixture();
  const archive = await request(fixture.router, {
    method: 'POST',
    path: '/v1/projects/project%2Fone/runs',
    body: { kind: 'archive', blobId: 'sha256:one' },
    headers: { 'idempotency-key': 'archive-key' },
  });
  assert.equal(archive.status, 202);
  assert.equal(archive.headers['x-workflow-result'], 'archive');
  assert.deepEqual(archive.body, { runId: 'run-archive', status: 'running' });

  const checks = await request(fixture.router, {
    method: 'POST',
    path: '/v1/projects/project%2Fone/check-runs',
    body: { seriesId: 'series-1', checkIds: ['test'] },
    headers: { 'idempotency-key': 'checks-key' },
  });
  assert.equal(checks.status, 202);
  assert.deepEqual(checks.body, { runId: 'run-checks', status: 'running' });

  const deploy = await request(fixture.router, {
    method: 'POST',
    path: '/v1/projects/project%2Fone/deploy-runs',
    body: { seriesId: 'series-deploy-1' },
    headers: { 'idempotency-key': 'deploy-key' },
  });
  assert.equal(deploy.status, 202);
  assert.deepEqual(deploy.body, { runId: 'run-deploy', status: 'running' });

  const action = await request(fixture.router, {
    method: 'POST',
    path: '/v1/runs/run%2Fone/actions/resolve%2Fconflict',
    body: { input: { path: 'src/a.js', decision: 'archive' } },
    headers: { 'idempotency-key': 'action-key', 'if-match': '"7"' },
  });
  assert.equal(action.status, 200);
  assert.equal(action.headers['x-workflow-result'], 'action');
  assert.deepEqual(action.body, { actionId: 'resolve/conflict', replayed: false });

  assert.deepEqual(fixture.calls, [
    call('startArchiveRun', {
      projectId: 'project/one',
      body: { kind: 'archive', blobId: 'sha256:one' },
      idempotencyKey: 'archive-key',
    }),
    call('startCheckRun', {
      projectId: 'project/one',
      body: { seriesId: 'series-1', checkIds: ['test'] },
      idempotencyKey: 'checks-key',
    }),
    call('startDeployRun', {
      projectId: 'project/one',
      body: { seriesId: 'series-deploy-1' },
      idempotencyKey: 'deploy-key',
    }),
    call('dispatchAction', {
      runId: 'run/one',
      actionId: 'resolve/conflict',
      expectedRevision: 7,
      input: { path: 'src/a.js', decision: 'archive' },
      idempotencyKey: 'action-key',
    }),
  ]);
});

test('workflow reads preserve resources, queries, envelopes, and surface ETags', async () => {
  const fixture = workflowFixture({
    results: {
      getReport: {
        status: 206,
        headers: { 'x-workflow-result': 'report' },
        body: { kind: 'report', sanitized: true },
      },
    },
  });
  const run = await request(fixture.router, { path: '/v1/runs/run%2Fone' });
  const surface = await request(fixture.router, { path: '/v1/runs/run%2Fone/surface' });
  const plan = await request(fixture.router, {
    path: '/v1/runs/run%2Fone/plan?group=changed%20files&cursor=opaque%2B%2F%3D%3F%26&limit=25',
  });
  const diff = await request(fixture.router, {
    path: '/v1/runs/run%2Fone/diff?path=src%2Fa%20b.js%3Fx%3D1&mode=unified%2Ffull',
  });
  const output = await request(fixture.router, {
    path: '/v1/runs/run%2Fone/output?source=checks&cursor=next%2F%2B%3F%3D',
  });
  const report = await request(fixture.router, { path: '/v1/runs/run%2Fone/report' });
  const history = await request(fixture.router, {
    path: '/v1/projects/project%2Fone/history?cursor=history%2F%2B%3F%3D&limit=10&status=waiting%20action',
  });

  assert.deepEqual(run.body, { runId: 'run/one', kind: 'run' });
  assert.equal(surface.headers.etag, '"11"');
  assert.deepEqual(surface.body, { id: 'surface-1', revision: 11, kind: 'plan_review' });
  assert.equal(plan.body.kind, 'plan');
  assert.equal(diff.body.kind, 'diff');
  assert.equal(output.body.kind, 'output');
  assert.equal(report.status, 206);
  assert.equal(report.headers['x-workflow-result'], 'report');
  assert.equal(history.body.kind, 'history');
  assert.deepEqual(fixture.calls, [
    call('getRun', { runId: 'run/one' }),
    call('getSurface', { runId: 'run/one' }),
    call('getPlan', {
      runId: 'run/one',
      query: { group: 'changed files', cursor: 'opaque+/=?&', limit: 25 },
    }),
    call('getDiff', {
      runId: 'run/one',
      query: { path: 'src/a b.js?x=1', mode: 'unified/full' },
    }),
    call('getOutput', {
      runId: 'run/one',
      query: { source: 'checks', cursor: 'next/+?=' },
    }),
    call('getReport', { runId: 'run/one' }),
    call('getHistory', {
      projectId: 'project/one',
      query: { cursor: 'history/+?=', limit: 10, status: 'waiting action' },
    }),
  ]);
});

test('surface ETag is merged into an application route envelope', async () => {
  const fixture = workflowFixture({
    results: {
      getSurface: {
        status: 203,
        headers: { 'x-workflow-result': 'surface' },
        body: { id: 'surface-envelope', revision: 19 },
      },
    },
  });
  const response = await request(fixture.router, { path: '/v1/runs/run-1/surface' });
  assert.equal(response.status, 203);
  assert.equal(response.headers.etag, '"19"');
  assert.equal(response.headers['x-workflow-result'], 'surface');
});

test('workflow route queries reject unknown, repeated, missing, and unsafe values', async () => {
  const fixture = workflowFixture();
  const invalidPaths = [
    '/v1/runs/run-1?unknown=value',
    '/v1/runs/run-1/surface?fixture=value',
    '/v1/runs/run-1/report?format=raw',
    '/v1/runs/run-1/plan?cursor=one&cursor=two',
    '/v1/runs/run-1/plan?unknown=value',
    '/v1/runs/run-1/plan?group=',
    '/v1/runs/run-1/plan?group=%0A',
    '/v1/runs/run-1/plan?limit=0',
    '/v1/runs/run-1/plan?limit=01',
    '/v1/runs/run-1/plan?limit=1.5',
    '/v1/runs/run-1/plan?limit=9007199254740992',
    '/v1/runs/run-1/diff',
    '/v1/runs/run-1/diff?path=',
    '/v1/runs/run-1/output',
    '/v1/runs/run-1/output?source=raw',
    '/v1/projects/project-1/history?limit=1&limit=2',
  ];
  for (const path of invalidPaths) {
    const response = await request(fixture.router, { path });
    assert.equal(response.status, 400, path);
    assert.equal(response.body.code, 'ACTION_INPUT_INVALID', path);
  }
  assert.deepEqual(fixture.calls, []);
});

test('workflow mutations reject invalid bodies, CAS, missing keys, and shutdown', async () => {
  const fixture = workflowFixture();
  const invalid = [
    {
      path: '/v1/projects/project-1/runs',
      body: { kind: 'checks' },
      headers: { 'idempotency-key': 'key-1' },
      status: 400,
      code: 'ACTION_INPUT_INVALID',
    },
    {
      path: '/v1/projects/project-1/check-runs',
      body: [],
      headers: { 'idempotency-key': 'key-2' },
      status: 400,
      code: 'ACTION_INPUT_INVALID',
    },
    {
      path: '/v1/projects/project-1/runs?unexpected=true',
      body: { kind: 'archive' },
      headers: { 'idempotency-key': 'key-query' },
      status: 400,
      code: 'ACTION_INPUT_INVALID',
    },
    actionCase({}, '"1"'),
    actionCase({ input: {}, extra: true }, '"1"'),
    actionCase({ input: [] }, '"1"'),
    actionCase({ input: {} }, '1', 409, 'STALE_REVISION'),
    actionCase({ input: {} }, undefined, 409, 'STALE_REVISION'),
    {
      path: '/v1/projects/project-1/runs',
      body: { kind: 'archive' },
      headers: {},
      status: 400,
      code: 'IDEMPOTENCY_REQUIRED',
    },
  ];
  for (const sample of invalid) {
    const response = await request(fixture.router, { method: 'POST', ...sample });
    assert.equal(response.status, sample.status, sample.path);
    assert.equal(response.body.code, sample.code, sample.path);
  }
  assert.deepEqual(fixture.calls, []);

  const stopping = workflowFixture({ acceptingMutations: () => false });
  const rejected = await request(stopping.router, {
    method: 'POST',
    path: '/v1/projects/project-1/runs',
    body: { kind: 'archive' },
    headers: { 'idempotency-key': 'stopping-key' },
  });
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.code, 'OPERATION_BUSY');
  const readable = await request(stopping.router, { path: '/v1/runs/run-1' });
  assert.equal(readable.status, 200);
  assert.deepEqual(stopping.calls, [call('getRun', { runId: 'run-1' })]);
});

function workflowFixture({ results = {}, acceptingMutations = () => true } = {}) {
  const calls = [];
  const application = fakeApplication(calls, results);
  const router = new LocalHttpRouter({
    token: 'test-token',
    problemFactory: createServerProblem,
  });
  registerWorkflowRoutes(router, { application, acceptingMutations });
  return { router, application, calls };
}

function fakeApplication(calls, overrides) {
  const defaults = {
    startArchiveRun: { status: 202, headers: { 'x-workflow-result': 'archive' }, body: { runId: 'run-archive', status: 'running' } },
    startCheckRun: { status: 202, body: { runId: 'run-checks', status: 'running' } },
    startDeployRun: { status: 202, body: { runId: 'run-deploy', status: 'running' } },
    getRun: ({ runId }) => ({ runId, kind: 'run' }),
    getSurface: { id: 'surface-1', revision: 11, kind: 'plan_review' },
    dispatchAction: ({ actionId }) => ({ status: 200, headers: { 'x-workflow-result': 'action' }, body: { actionId, replayed: false } }),
    getPlan: { kind: 'plan', items: [] },
    getDiff: { kind: 'diff', hunks: [] },
    getOutput: { kind: 'output', items: [] },
    getReport: { kind: 'report', sanitized: true },
    getHistory: { kind: 'history', items: [] },
  };
  return Object.fromEntries(APPLICATION_METHODS.map((name) => [name, async (requestValue) => {
    calls.push(call(name, requestValue));
    const configured = Object.hasOwn(overrides, name) ? overrides[name] : defaults[name];
    const result = typeof configured === 'function' ? await configured(requestValue) : configured;
    return structuredClone(result);
  }]));
}

async function request(router, {
  method = 'GET',
  path,
  body = NO_BODY,
  headers = {},
} = {}) {
  const requestHeaders = { authorization: 'Bearer test-token' };
  for (const [name, value] of Object.entries(headers)) requestHeaders[name.toLowerCase()] = value;
  let payload = null;
  if (body !== NO_BODY) {
    payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    requestHeaders['content-type'] = requestHeaders['content-type'] ?? 'application/json';
    requestHeaders['content-length'] = String(payload.length);
  }
  const incoming = Readable.from(payload ? [payload] : []);
  incoming.method = method;
  incoming.url = path;
  incoming.headers = requestHeaders;
  const outgoing = fakeResponse();
  await router.handle(incoming, outgoing);
  const responseBody = Buffer.concat(outgoing.chunks).toString('utf8');
  return {
    status: outgoing.status,
    headers: outgoing.headers,
    body: responseBody ? JSON.parse(responseBody) : null,
  };
}

function fakeResponse() {
  return {
    status: null,
    headers: {},
    chunks: [],
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = { ...headers };
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
    destroy() {
      this.writableEnded = true;
    },
  };
}

function post(template, json) {
  return { method: 'POST', template, options: json ? { body: 'json', idempotency: true } : {} };
}

function get(template) {
  return { method: 'GET', template, options: {} };
}

function call(method, requestValue) {
  return { method, request: structuredClone(requestValue) };
}

function actionCase(body, ifMatch, status = 400, code = 'ACTION_INPUT_INVALID') {
  return {
    path: '/v1/runs/run-1/actions/apply',
    body,
    headers: {
      'idempotency-key': `action-${JSON.stringify(body)}`,
      ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
    },
    status,
    code,
  };
}
