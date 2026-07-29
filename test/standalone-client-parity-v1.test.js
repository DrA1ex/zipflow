import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { ClientBackedZipflowController } from '../src/standalone/client-controller.js';
import {
  connectStandaloneServer,
  StandaloneServerConnection,
} from '../src/standalone/local-server.js';
import { createStandaloneController } from '../src/index.js';

const HELLO = Object.freeze({
  apiVersion: '1.0',
  schemaRevision: 1,
  serverEpoch: 'epoch-1',
  capabilities: [],
});

test('released standalone path selects the client-backed controller and keeps direct mode explicit', () => {
  const state = createInitialState();
  assert.ok(createStandaloneController(state) instanceof ClientBackedZipflowController);
  assert.ok(createStandaloneController(createInitialState(), { directMode: true }) instanceof ZipflowController);
});

test('client-backed standalone boot preserves client-owned theme and localization state', async () => {
  const calls = [];
  const client = fakeClient({
    calls,
    project: projectResource({ workflowConfigured: true }),
    workflow: { projectId: 'project-1', revision: 3, workflow: { version: 9, checks: [] } },
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: '/project',
    createId: sequenceIds('instance-1', 'open-1'),
    settingsLoader: async () => ({
      ...state.settings,
      interfaceLanguage: 'ru',
      theme: 'forest',
    }),
    i18nConfigurator: async (language) => ({
      configuredLanguage: language,
      languageId: language,
      available: [],
    }),
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });
  await controller.boot();
  assert.equal(state.settings.theme, 'forest');
  assert.equal(state.i18n.languageId, 'ru');
  await controller.cleanup();
});

test('standalone connection authenticates an owned or reused portable local endpoint', async () => {
  const calls = [];
  const ownedServer = {
    reused: false,
    token: 'owned-token-value-at-least-twenty',
    discovery: { socketPath: '/tmp/zipflow-owned.sock' },
    async close() { calls.push('owned-close'); },
  };
  const owned = await connectStandaloneServer({
    paths: fixturePaths('unix', '/tmp/zipflow-owned.sock'),
    security: { readPrivateFile() { throw new Error('owned token must not be reread'); } },
    startServer: async () => ownedServer,
    clientFactory: async (options) => ({
      options,
      async hello() { return HELLO; },
      async close() { calls.push('client-close'); },
    }),
  });
  assert.equal(owned.owned, true);
  assert.equal(owned.endpoint, '/tmp/zipflow-owned.sock');
  assert.equal(owned.client.options.token, 'owned-token-value-at-least-twenty');
  await owned.close();
  assert.deepEqual(calls, ['client-close', 'owned-close']);

  const pipe = String.raw`\\.\pipe\zipflow-user-api-v1`;
  const reusedServer = {
    reused: true,
    discovery: { socketPath: pipe },
    async close() { calls.push('reused-close'); },
  };
  const reused = await connectStandaloneServer({
    paths: fixturePaths('named-pipe', pipe),
    security: {
      async readPrivateFile(target) {
        assert.equal(target, 'C:\\runtime\\server-v1.token');
        return 'reused-token-value-at-least-twenty\n';
      },
    },
    startServer: async () => reusedServer,
    clientFactory: async (options) => ({
      options,
      async hello() { return HELLO; },
    }),
  });
  assert.equal(reused.owned, false);
  assert.deepEqual(reused.client.options.endpoint, { kind: 'named-pipe', socketPath: pipe });
  await reused.close();
  assert.equal(calls.includes('reused-close'), false);
});

test('standalone controller opens a project and saves only the server-provided workflow draft', async () => {
  const calls = [];
  const suggestedWorkflow = {
    version: 9,
    name: 'Fixture',
    projectPath: '/project',
    checks: [],
    archive: { mode: 'overlay' },
  };
  const client = fakeClient({
    calls,
    project: projectResource({ workflowConfigured: false }),
    workflow: {
      projectId: 'project-1',
      revision: 0,
      workflow: null,
      suggestedWorkflow,
    },
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: '/project',
    createId: sequenceIds('instance-1', 'open-1', 'save-1'),
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });
  await controller.boot();
  assert.equal(state.screen, 'home');
  assert.equal(state.menuItems.some(({ id }) => id === 'server:archive' && !state.menuItems.disabled), true);
  await controller.showWorkflow();
  assert.equal(state.screen, 'setup-review');
  await controller.saveWorkflow();
  assert.deepEqual(calls.find(({ method }) => method === 'putWorkflow'), {
    method: 'putWorkflow',
    projectId: 'project-1',
    draft: suggestedWorkflow,
    options: {
      ifMatch: 0,
      idempotencyKey: 'zipflow:tui:workflow:project-1:0',
    },
  });
  await controller.cleanup();
});

test('standalone archive flow streams the selected file and uses semantic run actions', async () => {
  const calls = [];
  const surface = semanticSurface();
  const client = fakeClient({
    calls,
    project: projectResource({ workflowConfigured: true }),
    workflow: { projectId: 'project-1', revision: 3, workflow: { version: 9, checks: [] } },
    surface,
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: '/project',
    createId: sequenceIds('instance-1', 'open-1', 'blob-1', 'request-1', 'run-1', 'action-1'),
    statFile: async (target) => {
      assert.equal(target, '/archives/result.zip');
      return { size: 6, isFile: () => true };
    },
    createFileStream: (target) => {
      assert.equal(target, '/archives/result.zip');
      return Readable.from([Buffer.from('PKDATA')]);
    },
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });
  await controller.boot();
  await controller.startArchive('/archives/result.zip');
  assert.equal(controller.runId, 'run-1');
  assert.equal(calls.filter(({ method }) => method === 'uploadZip').length, 1);
  assert.equal(calls.filter(({ method }) => method === 'startArchiveRun').length, 1);
  await controller.performAction(surface.actions[0], {});
  assert.deepEqual(calls.find(({ method }) => method === 'performAction'), {
    method: 'performAction',
    runId: 'run-1',
    actionId: 'approve-plan',
    input: {},
    options: {
      ifMatch: 7,
      idempotencyKey: 'zipflow:tui:action:run-1:approve-plan:action-1',
    },
  });
  await controller.cleanup();
});

test('standalone plan navigation renders server diffs and double-confirms dangerous actions', async () => {
  const calls = [];
  const surface = semanticSurface();
  const client = fakeClient({
    calls,
    project: projectResource({ workflowConfigured: true }),
    workflow: { projectId: 'project-1', revision: 3, workflow: { version: 9, checks: [] } },
    surface,
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: '/project',
    createId: sequenceIds('instance-1', 'open-1', 'dangerous-action-1'),
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });
  await controller.boot();
  controller.runId = 'run-1';
  state.serverSurface = surface;
  await controller.showPlan();
  assert.equal(state.menuItems[0].diffPath, 'src/index.js');
  await controller.showDiff('src/index.js');
  assert.equal(state.screen, 'diff-view');
  assert.equal(state.diffView.diff.rows[0].type, 'remove');
  assert.equal(state.diffView.diff.rows[1].type, 'add');

  const rollback = {
    ...surface.actions[0],
    id: 'rollback',
    kind: 'rollback',
    label: 'Roll back',
    confirmation: 'dangerous',
  };
  await controller.activateAction(rollback);
  assert.equal(calls.some(({ method }) => method === 'performAction'), false);
  assert.equal(state.menuItems[0].id, 'server:confirm-action');
  await controller.activateSelected();
  assert.equal(calls.some(({ method, actionId }) => method === 'performAction' && actionId === 'rollback'), true);
  await controller.cleanup();
});

function fixturePaths(kind, socketPath) {
  return {
    endpoint: { kind, socketPath },
    tokenPath: kind === 'named-pipe'
      ? 'C:\\runtime\\server-v1.token'
      : '/tmp/runtime/server-v1.token',
  };
}

function projectResource({ workflowConfigured }) {
  return {
    projectId: 'project-1',
    canonicalPath: '/project',
    project: { name: 'Fixture', technologies: [], labels: [] },
    workflowConfigured,
    workflowRevision: workflowConfigured ? 3 : 0,
    activeRunId: null,
    activeOperations: [],
    surface: {},
  };
}

function semanticSurface() {
  return {
    id: 'plan-review:run-1',
    kind: 'plan_review',
    revision: 7,
    title: 'Review plan',
    summary: 'One file changes',
    stage: { id: 'plan', index: 2, count: 5 },
    sections: [{ id: 'summary', kind: 'plan_summary', files: 1, groups: 1, unresolvedConflicts: 0 }],
    actions: [{
      id: 'approve-plan',
      kind: 'approve_plan',
      label: 'Apply plan',
      description: 'Apply the reviewed plan.',
      enabled: true,
      disabledReason: null,
      risk: 'project_write',
      confirmation: 'explicit',
      inputSchema: null,
      presentation: { role: 'primary' },
    }],
    links: {
      run: '/v1/runs/run-1',
      plan: '/v1/runs/run-1/plan',
      self: '/v1/runs/run-1/surface',
    },
  };
}

function fakeClient({
  calls,
  project,
  workflow,
  surface = semanticSurface(),
}) {
  return {
    async openProject(request) {
      calls.push({ method: 'openProject', request });
      return structuredClone(project);
    },
    async getProject() {
      calls.push({ method: 'getProject' });
      return { ...structuredClone(project), workflowConfigured: true, workflowRevision: 1 };
    },
    async getWorkflow() {
      calls.push({ method: 'getWorkflow' });
      return structuredClone(workflow);
    },
    async putWorkflow(projectId, draft, options) {
      calls.push({ method: 'putWorkflow', projectId, draft, options });
      return { projectId, revision: options.ifMatch + 1, workflow: structuredClone(draft) };
    },
    async uploadZip(source, options) {
      const chunks = [];
      for await (const chunk of source) chunks.push(chunk);
      calls.push({ method: 'uploadZip', options, bytes: Buffer.concat(chunks) });
      return { blobId: 'sha256:fixture', sha256: 'fixture', size: 6, filename: 'result.zip' };
    },
    async startArchiveRun(projectId, draft, options) {
      calls.push({ method: 'startArchiveRun', projectId, draft, options });
      return { runId: 'run-1', operationId: 'operation-1', status: 'running' };
    },
    async getRun() {
      calls.push({ method: 'getRun' });
      return { runId: 'run-1', status: 'waiting_action', revision: 7, operationId: null };
    },
    async getSurface() {
      calls.push({ method: 'getSurface' });
      return structuredClone(surface);
    },
    async performAction(runId, actionId, input, options) {
      calls.push({ method: 'performAction', runId, actionId, input, options });
      return { revision: 8 };
    },
    async getPlan() {
      calls.push({ method: 'getPlan' });
      return {
        items: [{ path: 'src/index.js', kind: 'updated' }],
        nextCursor: null,
      };
    },
    async getDiff() {
      calls.push({ method: 'getDiff' });
      return {
        path: 'src/index.js',
        binary: false,
        hunks: [{
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [
            { type: 'remove', oldLine: 1, newLine: null, oldText: 'old', newText: '' },
            { type: 'add', oldLine: null, newLine: 1, oldText: '', newText: 'new' },
          ],
        }],
      };
    },
    events() {
      return (async function* empty() {})();
    },
    async close() {
      calls.push({ method: 'close' });
    },
  };
}

function sequenceIds(...ids) {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}
