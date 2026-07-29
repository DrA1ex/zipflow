import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import {
  lstat,
  mkdtemp,
  mkdir,
  realpath,
  rm,
} from 'node:fs/promises';
import {
  assertProtocolValue,
  ZipflowApiError,
} from '../src/protocol/index.js';
import { ZipflowClient } from '../src/client/index.js';
import {
  workflowSemanticFingerprint,
} from '../src/application/workflow-resource-store.js';
import { fingerprintRequest } from '../src/server/idempotency-store.js';
import { createServerProblem } from '../src/server/problems.js';
import { resolveServerPaths } from '../src/server/runtime-paths.js';
import { startZipflowServer } from '../src/server/server.js';

test('authenticated server serves hello, schemas, and compatible discovery reuse', async (t) => {
  const fixture = await serverFixture(t);
  const client = fixture.client();
  const hello = await client.hello();
  assert.equal(hello.serverEpoch, fixture.server.lifecycle.serverEpoch);
  assert.equal((await client.getOpenApi()).openapi, '3.1.0');
  assert.ok((await client.getSchemas()).schemas.hello);

  const unauthorized = await rawRequest(fixture.socketPath, {
    path: '/v1/hello',
    token: 'wrong-token',
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.code, 'AUTH_REQUIRED');
  assertProtocolValue('problem', unauthorized.body);

  const reused = await startZipflowServer({
    paths: fixture.paths,
    token: fixture.token,
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.discovery.serverEpoch, hello.serverEpoch);
  await reused.close();
});

test('project and blob infrastructure is idempotent through authenticated HTTP', async (t) => {
  const fixture = await serverFixture(t, { blobMaxBytes: 16 });
  const projectPath = path.join(fixture.home, 'project');
  await mkdir(projectPath);
  const client = fixture.client();
  const request = {
    method: 'POST',
    body: { path: projectPath, client: { name: 'test', instanceId: 'one' } },
    headers: { 'idempotency-key': 'open-project-1' },
  };
  const opened = await client.requestJson('/v1/projects/open', request);
  const replay = await client.requestJson('/v1/projects/open', request);
  assert.deepEqual(replay, opened);
  assert.equal(opened.canonicalPath, await realpath(projectPath));
  assert.deepEqual(await client.requestJson(`/v1/projects/${opened.projectId}`), opened);

  await assert.rejects(
    client.requestJson('/v1/projects/open', {
      ...request,
      body: { ...request.body, client: { name: 'test', instanceId: 'two' } },
    }),
    (error) => error instanceof ZipflowApiError && error.code === 'IDEMPOTENCY_CONFLICT',
  );

  const archive = Buffer.from('PK\u0003\u0004zip');
  const first = await client.uploadZip(archive, {
    filename: '../../result.zip',
    contentLength: archive.length,
    idempotencyKey: 'blob-1',
  });
  const second = await client.uploadZip(archive, {
    filename: '../../result.zip',
    contentLength: archive.length,
    idempotencyKey: 'blob-1',
  });
  assert.deepEqual(second, first);
  assert.equal(first.filename, 'result.zip');
  await assert.rejects(
    client.uploadZip(Buffer.alloc(17), {
      filename: 'large.zip',
      contentLength: 17,
      idempotencyKey: 'blob-large',
    }),
    (error) => error instanceof ZipflowApiError && error.code === 'ARCHIVE_LIMIT_EXCEEDED',
  );
});

test('workflow GET and PUT expose ETags, normalize drafts, and enforce durable CAS receipts', async (t) => {
  const fixture = await serverFixture(t, {}, { bindProcessHome: true });
  const projectPath = path.join(fixture.home, 'workflow-project');
  await mkdir(projectPath);
  const client = fixture.client();
  const opened = await client.openProject({
    path: projectPath,
    client: { name: 'test', instanceId: 'workflow-cas' },
    idempotencyKey: 'workflow-open-1',
  });
  assert.equal(opened.workflowConfigured, false);
  assert.equal(opened.workflowRevision, 0);

  const initial = await rawRequest(fixture.socketPath, {
    path: `/v1/projects/${opened.projectId}/workflow`,
    token: fixture.token,
  });
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.etag, '"0"');
  assert.equal(initial.body.projectId, opened.projectId);
  assert.equal(initial.body.revision, 0);
  assert.equal(initial.body.workflow, null);
  assert.equal(initial.body.suggestedWorkflow.version, 9);
  assert.equal(initial.body.suggestedWorkflow.projectPath, await realpath(projectPath));

  const draft = workflowDraft('Normalized workflow');
  const saved = await client.putWorkflow(opened.projectId, draft, {
    ifMatch: 0,
    idempotencyKey: 'workflow-put-1',
  });
  assert.equal(saved.projectId, opened.projectId);
  assert.equal(saved.revision, 1);
  assert.equal(saved.workflow.version, 9);
  assert.equal(saved.workflow.name, 'Normalized workflow');
  assert.equal(saved.workflow.projectPath, await realpath(projectPath));
  assert.equal(saved.workflow.archive.mode, 'overlay');
  assert.equal(saved.workflow.exclude.includes('.git/**'), true);
  assert.equal(saved.workflow.exclude.includes('custom/**'), true);
  assert.equal(Number.isFinite(Date.parse(saved.workflow.createdAt)), true);
  assert.equal(Number.isFinite(Date.parse(saved.workflow.updatedAt)), true);

  const replay = await client.putWorkflow(opened.projectId, draft, {
    ifMatch: '"0"',
    idempotencyKey: 'workflow-put-1',
  });
  assert.deepEqual(replay, saved);
  const current = await client.getWorkflow(opened.projectId);
  assert.deepEqual(current, saved);
  const currentRaw = await rawRequest(fixture.socketPath, {
    path: `/v1/projects/${opened.projectId}/workflow`,
    token: fixture.token,
  });
  assert.equal(currentRaw.headers.etag, '"1"');

  await assert.rejects(
    client.putWorkflow(opened.projectId, workflowDraft('Conflicting key reuse'), {
      ifMatch: 0,
      idempotencyKey: 'workflow-put-1',
    }),
    (error) => error instanceof ZipflowApiError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
  await assert.rejects(
    client.putWorkflow(opened.projectId, workflowDraft('Stale revision'), {
      ifMatch: 0,
      idempotencyKey: 'workflow-put-stale-1',
    }),
    (error) => {
      assert.ok(error instanceof ZipflowApiError);
      assert.equal(error.code, 'STALE_REVISION');
      assert.equal(error.details.currentRevision, 1);
      return true;
    },
  );
  assert.deepEqual(await client.getWorkflow(opened.projectId), saved);
});

test('workflow PUT receipt is reconciled after restart without repeating the mutation', async (t) => {
  const fixture = await serverFixture(t, {}, { bindProcessHome: true });
  const projectPath = path.join(fixture.home, 'workflow-reconcile-project');
  await mkdir(projectPath);
  const client = fixture.client();
  const opened = await client.openProject({
    path: projectPath,
    client: { name: 'test', instanceId: 'workflow-reconcile' },
    idempotencyKey: 'workflow-reconcile-open-1',
  });
  const project = await fixture.server.projects.get(opened.projectId);
  const draft = workflowDraft('Recovered workflow');
  const idempotencyKey = 'workflow-reconcile-put-1';
  const expectedRevision = 0;
  const fingerprint = fingerprintRequest({
    method: 'PUT',
    path: `/v1/projects/${opened.projectId}/workflow`,
    expectedRevision,
    body: draft,
  });
  await fixture.server.idempotency.claim({
    key: idempotencyKey,
    fingerprint,
    metadata: {
      kind: 'workflow-put',
      projectId: opened.projectId,
      expectedRevision,
      workflowHash: workflowSemanticFingerprint({
        ...draft,
        projectPath: project.canonicalPath,
      }),
    },
  });
  const persisted = await fixture.server.workflows.replace({ project, draft, expectedRevision });
  assert.equal(persisted.revision, 1);
  await fixture.server.close();

  const restarted = await startZipflowServer(fixture.serverOptions);
  t.after(() => restarted.close().catch(() => {}));
  const reconciled = await restarted.idempotency.get(idempotencyKey);
  assert.equal(reconciled.status, 'completed');
  assert.equal(reconciled.receipt.body.revision, 1);
  const replay = await new ZipflowClient({
    socketPath: fixture.socketPath,
    token: fixture.token,
  }).putWorkflow(opened.projectId, draft, {
    ifMatch: 0,
    idempotencyKey,
  });
  assert.equal(replay.revision, 1);
  assert.equal(replay.workflow.name, 'Recovered workflow');
  assert.equal((await restarted.workflows.get(project)).revision, 1);
});

test('operation cancellation and SSE replay use durable server resources', async (t) => {
  const fixture = await serverFixture(t, { eventMaxRecords: 4 });
  const client = fixture.client();
  const handle = await fixture.server.operations.begin({
    projectId: 'project-events',
    kind: 'checks',
  });
  const events = client.events({
    operationId: handle.operationId,
    lastEventId: 0,
    serverEpoch: fixture.server.lifecycle.serverEpoch,
  })[Symbol.asyncIterator]();
  const started = await events.next();
  assert.equal(started.value.type, 'operation.started');
  assert.equal(started.value.operationId, handle.operationId);
  await events.return();

  const cancelled = await client.requestJson(`/v1/operations/${handle.operationId}/cancel`, {
    method: 'POST',
    headers: { 'idempotency-key': 'cancel-operation-1' },
  });
  assert.equal(cancelled.settlement, 'cancel_requested');
  assert.equal(handle.signal.aborted, true);
  await handle.settle('cancelled');

  for (let index = 0; index < 5; index += 1) {
    await fixture.server.journal.append('project.changed', {
      projectId: `project-${index}`,
      data: { index },
    });
  }
  const gapEvents = client.events({
    lastEventId: 0,
    serverEpoch: fixture.server.lifecycle.serverEpoch,
  })[Symbol.asyncIterator]();
  const gap = await gapEvents.next();
  assert.equal(gap.value.type, 'stream.gap');
  assert.equal(gap.value.data.retainedFrom > 1, true);
});

test('every HTTP error is a schema-valid redacted protocol problem', async (t) => {
  const fixture = await serverFixture(t, { blobMaxBytes: 4 });
  fixture.server.router.get('/v1/test-internal', async () => {
    throw new Error(`Bearer ${fixture.token} at /Users/private/credentials.json`);
  });
  const results = [
    await rawRequest(fixture.socketPath, { path: '/v1/missing', token: fixture.token }),
    await rawRequest(fixture.socketPath, {
      path: '/v1/blobs',
      method: 'POST',
      token: fixture.token,
      headers: {
        'content-length': '0',
        'content-type': 'application/zip',
        'x-zipflow-filename': 'empty.zip',
      },
    }),
    await rawRequest(fixture.socketPath, { path: '/v1/test-internal', token: fixture.token }),
  ];
  results.push({
    status: 418,
    body: createServerProblem({
      status: 418,
      code: 'UNKNOWN_INTERNAL_CODE',
      detail: `Authorization Bearer ${fixture.token}`,
    }),
  });
  for (const result of results) {
    assert.equal(result.status >= 400, true);
    assertProtocolValue('problem', result.body);
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes(fixture.token), false);
    assert.equal(serialized.includes('/Users/private'), false);
  }
  assert.equal(results[1].body.code, 'IDEMPOTENCY_REQUIRED');
  assert.equal(results[2].body.code, 'INTERNAL_ERROR');

  const malformedResponse = fakeResponse();
  await fixture.server.router.handle({
    url: 'http://[',
    method: 'GET',
    headers: { authorization: `Bearer ${fixture.token}` },
  }, malformedResponse);
  assert.equal(malformedResponse.status, 400);
  assert.equal(malformedResponse.body.code, 'ACTION_INPUT_INVALID');
  assertProtocolValue('problem', malformedResponse.body);
});

test('failed listen cleanup never unlinks a same-user endpoint it did not bind', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'zipflow-foreign-endpoint-'));
  const socketPath = path.join(home, 'endpoint', 'custom.sock');
  await mkdir(path.dirname(socketPath), { mode: 0o700 });
  const foreign = net.createServer((socket) => socket.end('foreign'));
  foreign.listen(socketPath);
  await once(foreign, 'listening');
  t.after(async () => {
    if (foreign.listening) {
      const closed = once(foreign, 'close');
      foreign.close();
      await closed;
    }
    await rm(home, { recursive: true, force: true });
  });

  const paths = resolveServerPaths({ zipflowHome: home, socketPath });
  await assert.rejects(
    startZipflowServer({ paths, token: 'contender-token' }),
    (error) => error?.code === 'EADDRINUSE',
  );
  assert.equal((await lstat(socketPath)).isSocket(), true);
});

async function serverFixture(t, options = {}, { bindProcessHome = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'zipflow-http-server-'));
  const socketPath = path.join(home, 'endpoint', 'custom.sock');
  const paths = resolveServerPaths({ zipflowHome: home, socketPath });
  const token = 'test-runtime-token';
  const previousHome = process.env.ZIPFLOW_HOME;
  if (bindProcessHome) process.env.ZIPFLOW_HOME = home;
  const inspectProject = async (target) => {
    const root = await realpath(target);
    return {
      root,
      name: path.basename(root),
      workspaceTechnologies: [],
      workspaceLabels: [],
    };
  };
  const workflowSummary = async () => ({
    workflowConfigured: false,
    workflowRevision: null,
  });
  const serverOptions = {
    paths,
    token,
    inspectProject,
    workflowSummary,
    ...options,
  };
  const server = await startZipflowServer(serverOptions);
  t.after(async () => {
    await server.close().catch(() => {});
    if (bindProcessHome) {
      if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
      else process.env.ZIPFLOW_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    socketPath,
    paths,
    token,
    server,
    serverOptions,
    client: () => new ZipflowClient({ socketPath, token }),
  };
}

function workflowDraft(name) {
  return {
    name,
    checks: [],
    exclude: ['custom/**'],
  };
}

function rawRequest(socketPath, {
  path: requestPath,
  method = 'GET',
  token = null,
  headers = {},
  body = null,
}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: requestPath,
      method,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, async (response) => {
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      const source = Buffer.concat(chunks).toString('utf8');
      resolve({
        status: response.statusCode,
        headers: response.headers,
        body: source ? JSON.parse(source) : null,
      });
    });
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function fakeResponse() {
  return {
    writableEnded: false,
    headersSent: false,
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(payload) {
      this.writableEnded = true;
      this.body = payload ? JSON.parse(Buffer.from(payload).toString('utf8')) : null;
    },
    destroy() {
      this.writableEnded = true;
    },
  };
}
