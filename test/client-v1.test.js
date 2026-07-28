import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import {
  LocalEndpointHttpClient,
  ZipflowApiError,
  ZipflowClient,
  ZipflowCompatibilityError,
  normalizeLocalEndpoint,
} from 'zipflow/client';
import { createProblem, getConformanceFixture } from 'zipflow/protocol';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('public client and protocol imports are side-effect-free boundaries', async () => {
  const script = [
    "const before = { sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM') };",
    "const client = await import('zipflow/client');",
    "const protocol = await import('zipflow/protocol');",
    "const after = { sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM') };",
    "if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('signal handlers changed');",
    "if (!client.createZipflowClient || protocol.API_VERSION !== '1.0') throw new Error('exports missing');",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);

  const clientSources = await Promise.all([
    'index.js', 'local-endpoint.js', 'http-client.js', 'zipflow-client.js', 'sse-parser.js', 'event-client.js',
  ].map((name) => readFile(path.join(root, 'src/client', name), 'utf8')));
  const source = clientSources.join('\n');
  assert.doesNotMatch(source, /terlio|\.\.\/app\/|\.\.\/server\/|process\.on|node:child_process|node:fs/);
});

test('local endpoint normalization keeps Unix and future Windows named-pipe semantics separate', () => {
  assert.deepEqual(normalizeLocalEndpoint('/tmp/zipflow/api-v1.sock'), {
    kind: 'unix', socketPath: '/tmp/zipflow/api-v1.sock',
  });
  assert.deepEqual(normalizeLocalEndpoint('unix:///tmp/zipflow%20test.sock'), {
    kind: 'unix', socketPath: '/tmp/zipflow test.sock',
  });
  const namedPipe = String.raw`\\.\pipe\zipflow-api-v1`;
  assert.deepEqual(normalizeLocalEndpoint(namedPipe), { kind: 'named-pipe', socketPath: namedPipe });
  assert.deepEqual(normalizeLocalEndpoint({ kind: 'windows-pipe', path: namedPipe }), {
    kind: 'named-pipe', socketPath: namedPipe,
  });
  assert.throws(() => normalizeLocalEndpoint('relative.sock'), /absolute Unix socket path or a Windows named-pipe/);
  assert.throws(() => normalizeLocalEndpoint({ kind: 'unix', path: namedPipe }), /does not match/);
});

test('named-pipe endpoints reach the Node http.request socketPath boundary without POSIX rewriting', async () => {
  const namedPipe = String.raw`\\.\pipe\zipflow-api-v1`;
  let requestOptions;
  const requestImpl = (options, callback) => {
    requestOptions = options;
    const request = new EventEmitter();
    request.write = () => {};
    request.destroy = (error) => request.emit('error', error);
    request.end = () => queueMicrotask(() => {
      const response = Readable.from([JSON.stringify(getConformanceFixture('hello'))]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      callback(response);
    });
    return request;
  };
  const client = new ZipflowClient({ endpoint: namedPipe, token: 'pipe-token', requestImpl });
  const hello = await client.hello();
  assert.equal(hello.apiVersion, '1.0');
  assert.equal(requestOptions.socketPath, namedPipe);
  assert.equal(requestOptions.path, '/v1/hello');
  assert.equal(requestOptions.headers.authorization, 'Bearer pipe-token');
});

test('authenticated hello works over a Unix socket and maps problem responses', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'zipflow-client-v1-'));
  const socketPath = path.join(temporary, 'api.sock');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.headers.authorization !== 'Bearer correct-token') {
      response.writeHead(401, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify(createProblem('AUTH_REQUIRED')));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(getConformanceFixture('hello')));
  });

  try {
    server.listen(socketPath);
    await once(server, 'listening');
    const client = new ZipflowClient({ socketPath, token: 'correct-token' });
    assert.equal((await client.hello()).server.name, 'zipflow');

    const unauthorized = new ZipflowClient({ socketPath, token: 'wrong-token' });
    await assert.rejects(unauthorized.hello(), (error) => {
      assert.ok(error instanceof ZipflowApiError);
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.equal(error.status, 401);
      return true;
    });
    assert.deepEqual(requests, [
      { url: '/v1/hello', authorization: 'Bearer correct-token' },
      { url: '/v1/hello', authorization: 'Bearer wrong-token' },
    ]);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('hello negotiation rejects incompatible versions and missing capabilities before use', () => {
  const client = new ZipflowClient({
    httpClient: { requestJson() { throw new Error('not used'); } },
    requiredCapabilities: ['events', 'actions'],
  });
  const hello = getConformanceFixture('hello');
  assert.throws(() => client.assertCompatibility({ ...hello, apiVersion: '2.0' }), (error) => {
    assert.ok(error instanceof ZipflowCompatibilityError);
    assert.equal(error.code, 'API_INCOMPATIBLE');
    return true;
  });
  assert.throws(() => client.assertCompatibility({ ...hello, capabilities: ['events'] }), (error) => {
    assert.ok(error instanceof ZipflowCompatibilityError);
    assert.equal(error.code, 'CAPABILITY_MISSING');
    assert.deepEqual(error.details.missingCapabilities, ['actions']);
    return true;
  });
});

test('ZIP uploads stream raw bytes with explicit length and mutation headers', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'zipflow-upload-v1-'));
  const socketPath = path.join(temporary, 'api.sock');
  let received;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ blobId: 'sha256:fixture', size: received.body.length }));
  });
  try {
    server.listen(socketPath);
    await once(server, 'listening');
    const client = new ZipflowClient({ socketPath, token: 'upload-token' });
    const source = Readable.from([Buffer.from('PK'), Buffer.from([3, 4, 5, 6])]);
    const result = await client.uploadZip(source, {
      filename: 'result.zip', contentLength: 6, idempotencyKey: 'upload-fixture-1',
    });
    assert.deepEqual(result, { blobId: 'sha256:fixture', size: 6 });
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/v1/blobs');
    assert.equal(received.headers.authorization, 'Bearer upload-token');
    assert.equal(received.headers['content-type'], 'application/zip');
    assert.equal(received.headers['content-length'], '6');
    assert.equal(received.headers['idempotency-key'], 'upload-fixture-1');
    assert.equal(received.headers['x-zipflow-filename'], 'result.zip');
    assert.deepEqual(received.body, Buffer.from([0x50, 0x4b, 3, 4, 5, 6]));
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('workflow resource methods encode opaque IDs, cursors, paths, and quoted revisions', async () => {
  const calls = [];
  const controller = new AbortController();
  const client = new ZipflowClient({
    httpClient: {
      async requestJson(requestPath, options = {}) {
        calls.push({ path: requestPath, options });
        return { requestPath };
      },
    },
  });
  const projectId = 'project/id ?';
  const runId = 'run/id#1';
  const operationId = 'operation/id';
  const workflow = { name: 'SDK workflow', checks: [] };

  await client.openProject({
    path: 'C:\\work tree\\project',
    client: { name: 'chatgpt-bridge', instanceId: 'bridge/one' },
    idempotencyKey: 'open-project-1',
    signal: controller.signal,
  });
  await client.getProject(projectId);
  await client.getWorkflow(projectId);
  await client.putWorkflow(projectId, workflow, {
    ifMatch: 7,
    idempotencyKey: 'put-workflow-1',
    confirmation: 'explicit',
    confirmationId: 'bridge-only-metadata',
  });
  await client.startArchiveRun(projectId, { kind: 'archive', blobId: 'sha256:one' }, {
    idempotencyKey: 'archive-run-1',
  });
  await client.startCheckRun(projectId, { seriesId: 'series/one' }, {
    idempotencyKey: 'check-run-1',
  });
  await client.getRun(runId);
  await client.getOperation(operationId);
  await client.getSurface(runId);
  await client.performAction(runId, 'resolve/conflict', { path: 'src/a.js', decision: 'keep' }, {
    ifMatch: '"12"',
    idempotencyKey: 'action-1',
  });
  await client.getPlan(runId, {
    group: 'changed files', cursor: 'opaque+/=?& value', limit: '25',
  });
  await client.getDiff(runId, { path: 'src/a b.js?x=1', mode: 'unified/full' });
  await client.getOutput(runId, { source: 'checks', cursor: 'next/+?=' });
  await client.getReport(runId);
  await client.getHistory(projectId, { cursor: 'history/+?=', limit: 10, status: 'waiting action' });

  assert.deepEqual(calls.map(({ path: requestPath, options }) => ({
    path: requestPath,
    method: options.method ?? 'GET',
  })), [
    { path: '/v1/projects/open', method: 'POST' },
    { path: '/v1/projects/project%2Fid%20%3F', method: 'GET' },
    { path: '/v1/projects/project%2Fid%20%3F/workflow', method: 'GET' },
    { path: '/v1/projects/project%2Fid%20%3F/workflow', method: 'PUT' },
    { path: '/v1/projects/project%2Fid%20%3F/runs', method: 'POST' },
    { path: '/v1/projects/project%2Fid%20%3F/check-runs', method: 'POST' },
    { path: '/v1/runs/run%2Fid%231', method: 'GET' },
    { path: '/v1/operations/operation%2Fid', method: 'GET' },
    { path: '/v1/runs/run%2Fid%231/surface', method: 'GET' },
    { path: '/v1/runs/run%2Fid%231/actions/resolve%2Fconflict', method: 'POST' },
    {
      path: '/v1/runs/run%2Fid%231/plan?group=changed%20files&cursor=opaque%2B%2F%3D%3F%26%20value&limit=25',
      method: 'GET',
    },
    {
      path: '/v1/runs/run%2Fid%231/diff?path=src%2Fa%20b.js%3Fx%3D1&mode=unified%2Ffull',
      method: 'GET',
    },
    {
      path: '/v1/runs/run%2Fid%231/output?source=checks&cursor=next%2F%2B%3F%3D',
      method: 'GET',
    },
    { path: '/v1/runs/run%2Fid%231/report', method: 'GET' },
    {
      path: '/v1/projects/project%2Fid%20%3F/history?cursor=history%2F%2B%3F%3D&limit=10&status=waiting%20action',
      method: 'GET',
    },
  ]);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.deepEqual(calls[0].options.body, {
    path: 'C:\\work tree\\project',
    client: { name: 'chatgpt-bridge', instanceId: 'bridge/one' },
  });
  assert.deepEqual(calls[0].options.headers, { 'idempotency-key': 'open-project-1' });
  assert.deepEqual(calls[3].options.headers, {
    'idempotency-key': 'put-workflow-1',
    'if-match': '"7"',
  });
  assert.deepEqual(calls[3].options.body, workflow);
  assert.deepEqual(calls[9].options.headers, {
    'idempotency-key': 'action-1',
    'if-match': '"12"',
  });
  assert.deepEqual(calls[9].options.body, {
    input: { path: 'src/a.js', decision: 'keep' },
  });
});

test('workflow mutations validate IDs, keys, revisions, and are attempted only once', async () => {
  let attempts = 0;
  const failure = Object.assign(new Error('response boundary lost'), { code: 'CONNECTION_FAILED' });
  const client = new ZipflowClient({
    httpClient: {
      async requestJson() {
        attempts += 1;
        throw failure;
      },
    },
  });
  await assert.rejects(
    client.startArchiveRun('project-1', { kind: 'archive', blobId: 'sha256:one' }, {
      idempotencyKey: 'archive-once',
    }),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);

  await assert.rejects(client.getRun(''), /runId must be a non-empty safe string/);
  await assert.rejects(client.getOperation('operation\n2'), /operationId must be a non-empty safe string/);
  await assert.rejects(
    client.putWorkflow('project-1', {}, { ifMatch: 'W/"1"', idempotencyKey: 'put-1' }),
    /ifMatch must be a non-negative/,
  );
  await assert.rejects(
    client.performAction('run-1', '', {}, { ifMatch: 1, idempotencyKey: 'action-1' }),
    /actionId must be a non-empty safe string/,
  );
  await assert.rejects(
    client.startCheckRun('project-1', {}, {}),
    /idempotencyKey must contain/,
  );
  await assert.rejects(
    client.getPlan('run-1', { cursor: 'opaque', page: 2 }),
    /Unsupported query option: page/,
  );
  await assert.rejects(
    client.getHistory('project-1', { limit: 0 }),
    /limit must be a positive safe integer/,
  );
});

test('HTTP client owns Authorization and rejects remote or malformed request targets', async () => {
  const httpClient = new LocalEndpointHttpClient({ socketPath: '/tmp/not-open.sock', token: 'token' });
  await assert.rejects(httpClient.request('https://example.com/v1/hello'), /\/v1\/ resource paths/);
  await assert.rejects(httpClient.request('/v1/hello', {
    headers: { Authorization: 'Bearer another-token' },
  }), /Authorization is owned/);
});
