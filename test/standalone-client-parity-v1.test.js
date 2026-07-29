import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import path from 'node:path';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { ClientBackedZipflowController } from '../src/standalone/client-controller.js';
import { loadClientHistoryMetadata } from '../src/standalone/client-history-metadata.js';
import {
  connectStandaloneServer,
  StandaloneServerConnection,
} from '../src/standalone/local-server.js';
import { createStandaloneController } from '../src/index.js';
import { createZip, tempDir } from '../test-support/helpers.js';
import {
  fakeClient,
  fixturePaths,
  HELLO,
  projectResource,
  semanticSurface,
  sequenceIds,
} from './standalone-client-fixtures.js';

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

test('configured client-backed startup opens archive input and unconfigured startup keeps directory choice', async () => {
  const configuredState = createInitialState();
  const configuredController = new ClientBackedZipflowController(configuredState, {
    connect: async () => new StandaloneServerConnection({
      client: fakeClient({
        calls: [],
        project: projectResource({ workflowConfigured: true }),
        workflow: { projectId: 'project-1', revision: 3, workflow: { version: 9, checks: [] } },
      }),
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });
  const unconfiguredState = createInitialState();
  const unconfiguredController = new ClientBackedZipflowController(unconfiguredState, {
    connect: async () => new StandaloneServerConnection({
      client: fakeClient({
        calls: [],
        project: projectResource({ workflowConfigured: false }),
        workflow: { projectId: 'project-1', revision: 0, workflow: null, suggestedWorkflow: null },
      }),
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });

  try {
    await configuredController.boot();
    assert.equal(configuredState.screen, 'archive-input');
    await unconfiguredController.boot();
    assert.equal(unconfiguredState.screen, 'new-project');
    assert.equal(
      unconfiguredState.menuItems.some(({ id }) => id === 'server:choose-directory'),
      true,
    );
  } finally {
    await configuredController.cleanup();
    await unconfiguredController.cleanup();
  }
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
  assert.equal(state.screen, 'new-project');
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
  await controller.performAction(
    surface.actions.find(({ id }) => id === 'approve-plan'),
    {},
  );
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

test('server-backed archive input preserves path completion before uploading', async () => {
  const root = await tempDir('zipflow-client-path-parity-');
  const projectRoot = path.join(root, 'project');
  const archiveDir = path.join(root, 'archives');
  const archivePath = path.join(archiveDir, 'release.zip');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  await createZip(archivePath, { 'fixture/package.json': '{"name":"updated"}' });
  const calls = [];
  const client = fakeClient({
    calls,
    project: {
      ...projectResource({ workflowConfigured: true }),
      canonicalPath: projectRoot,
    },
    workflow: { projectId: 'project-1', revision: 3, workflow: { version: 9, checks: [] } },
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: projectRoot,
    settingsLoader: async () => ({
      ...state.settings,
      lastArchiveDirectory: archiveDir,
      recentArchivePaths: [],
    }),
    rememberArchive: async (currentState, value) => {
      currentState.settings.recentArchivePaths = [value];
      currentState.settings.lastArchiveDirectory = path.dirname(value);
    },
    i18nConfigurator: async () => ({ languageId: 'en', available: [] }),
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });

  try {
    await controller.boot();
    controller.promptArchive();
    state.editor.set(path.join(archiveDir, 'rele'));
    await controller.handleKey({ name: 'a', printable: true, text: 'a', sequence: 'a' });
    assert.equal(state.pathSuggestions.items.some(({ path: candidate }) => candidate === archivePath), true);

    await controller.handleKey({ name: 'tab' });
    assert.equal(state.editor.value, archivePath);
    assert.equal(calls.some(({ method }) => method === 'uploadZip'), false);

    await controller.handleKey({ name: 'enter' });
    assert.equal(calls.filter(({ method }) => method === 'uploadZip').length, 1);
    assert.equal(calls.filter(({ method }) => method === 'startArchiveRun').length, 1);
  } finally {
    await controller.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('server-backed archive input preserves deliberate double Enter discovery and selection', async () => {
  const root = await tempDir('zipflow-client-discovery-parity-');
  const projectRoot = path.join(root, 'project');
  const archiveDir = path.join(root, 'archives');
  const archivePath = path.join(archiveDir, 'matching.zip');
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  await writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(projectRoot, 'src', 'app.js'), 'export const value = 1;\n');
  await createZip(archivePath, {
    'fixture/package.json': '{"name":"updated"}',
    'fixture/src/app.js': 'export const value = 2;\n',
  });
  const calls = [];
  const client = fakeClient({
    calls,
    project: {
      ...projectResource({ workflowConfigured: true }),
      canonicalPath: projectRoot,
    },
    workflow: { projectId: 'project-1', revision: 3, workflow: { version: 9, checks: [] } },
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: projectRoot,
    settingsLoader: async () => ({
      ...state.settings,
      lastArchiveDirectory: archiveDir,
      recentArchivePaths: [],
    }),
    rememberArchive: async (currentState, value) => {
      currentState.settings.recentArchivePaths = [value];
      currentState.settings.lastArchiveDirectory = path.dirname(value);
    },
    i18nConfigurator: async () => ({ languageId: 'en', available: [] }),
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });

  try {
    await controller.boot();
    controller.promptArchive();
    await controller.handleKey({ name: 'enter' });
    assert.equal(state.screen, 'archive-input');
    assert.match(state.status, /Press Enter again/);

    await controller.handleKey({ name: 'enter' });
    assert.equal(state.screen, 'archive-discovery');
    assert.equal(state.menuItems[0].label, 'matching.zip');
    assert.equal(calls.some(({ method }) => method === 'uploadZip'), false);

    await controller.handleKey({ name: 'enter' });
    assert.equal(calls.filter(({ method }) => method === 'uploadZip').length, 1);
    assert.equal(calls.filter(({ method }) => method === 'startArchiveRun').length, 1);
  } finally {
    await controller.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('server-backed TUI applies the saved source archive policy after server completion', async () => {
  const root = await tempDir('zipflow-client-archive-policy-parity-');
  const projectRoot = path.join(root, 'project');
  const archivePath = path.join(root, 'completed-update.zip');
  await mkdir(projectRoot, { recursive: true });
  await createZip(archivePath, { 'created.txt': 'created\n' });
  const calls = [];
  const completedSurface = {
    ...semanticSurface(),
    id: 'completed:run-1',
    kind: 'completed',
    revision: 9,
    title: 'Run completed',
    summary: 'The update completed.',
    stage: { id: 'complete', index: 5, count: 5 },
    sections: [],
    actions: [],
  };
  const client = fakeClient({
    calls,
    project: {
      ...projectResource({ workflowConfigured: true }),
      canonicalPath: projectRoot,
    },
    workflow: { projectId: 'project-1', revision: 3, workflow: { version: 9, checks: [] } },
    surface: completedSurface,
    runResource: { runId: 'run-1', kind: 'archive', status: 'completed', revision: 9, operationId: null },
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: projectRoot,
    settingsLoader: async () => ({
      ...state.settings,
      archivePolicy: 'delete',
    }),
    rememberArchive: async () => {},
    i18nConfigurator: async () => ({ languageId: 'en', available: [] }),
    projectInspector: async () => ({
      root: projectRoot,
      name: 'Fixture',
      git: false,
      projects: [],
      checks: [],
      deployCandidates: [],
    }),
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });

  try {
    await controller.boot();
    await controller.startArchive(archivePath);
    await assert.rejects(stat(archivePath), { code: 'ENOENT' });
    assert.equal(state.run.archiveDisposition.action, 'deleted');
    assert.equal(
      (await loadClientHistoryMetadata('run-1')).archiveDisposition.action,
      'deleted',
    );
    assert.equal(
      state.messages.some(({ title }) => title === 'Source archive deleted'),
      true,
    );
  } finally {
    await controller.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('server-backed TUI preserves the duplicate archive confirmation before starting a new run', async () => {
  const root = await tempDir('zipflow-client-duplicate-parity-');
  const projectRoot = path.join(root, 'project');
  const archivePath = path.join(root, 'duplicate.zip');
  await mkdir(projectRoot, { recursive: true });
  await createZip(archivePath, { 'created.txt': 'created\n' });
  const calls = [];
  const client = fakeClient({
    calls,
    project: {
      ...projectResource({ workflowConfigured: true }),
      canonicalPath: projectRoot,
    },
    workflow: {
      projectId: 'project-1',
      revision: 3,
      workflow: { version: 9, checks: [], autonomy: { mode: 'manual' } },
    },
    historyItems: [{
      runId: 'previous-run',
      kind: 'archive',
      status: 'completed',
      blob: { blobId: 'sha256:fixture', sha256: 'fixture' },
    }],
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: projectRoot,
    rememberArchive: async () => {},
    projectInspector: async () => ({
      root: projectRoot,
      name: 'Fixture',
      git: false,
      projects: [],
      checks: [],
      deployCandidates: [],
    }),
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });

  try {
    await controller.boot();
    await controller.startArchive(archivePath);
    assert.equal(state.screen, 'archive-duplicate');
    assert.equal(calls.some(({ method }) => method === 'startArchiveRun'), false);
    assert.equal(state.menuItems[0].label, 'Inspect and apply again');
    await controller.handleKey({ name: 'enter' });
    assert.equal(calls.filter(({ method }) => method === 'startArchiveRun').length, 1);
  } finally {
    await controller.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('server-backed failed-check screen preserves copy, output, rerun, keep, and rollback choices', async () => {
  const calls = [];
  const failedSurface = {
    ...semanticSurface(),
    id: 'checks-failed:run-1',
    kind: 'checks_failed',
    revision: 11,
    title: 'Checks failed',
    summary: 'The update remains applied locally.',
    sections: [{
      id: 'checks',
      kind: 'check_results',
      status: 'failed',
      results: [{ id: 'lint', name: 'Lint', status: 'failed', summary: 'Check failed.' }],
    }],
    actions: [
      { ...semanticSurface().actions[0], id: 'retry-checks', kind: 'retry_checks', label: 'Run checks again' },
      { ...semanticSurface().actions[0], id: 'keep-changes', kind: 'keep_changes', label: 'Keep changes' },
      { ...semanticSurface().actions[0], id: 'rollback', kind: 'rollback', label: 'Roll back update', confirmation: 'dangerous' },
    ],
  };
  const client = fakeClient({
    calls,
    project: projectResource({ workflowConfigured: true }),
    workflow: { projectId: 'project-1', revision: 3, workflow: { version: 9, checks: [] } },
    surface: failedSurface,
    runResource: { runId: 'run-1', kind: 'archive', status: 'waiting_action', revision: 11, operationId: null },
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: '/project',
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });

  try {
    await controller.boot();
    controller.runId = 'run-1';
    await controller.refreshRun();
    assert.equal(state.screen, 'check-failed');
    assert.deepEqual(
      state.menuItems.filter(({ id }) => [
        'server:copy-failure',
        'server:view-failure',
        'server:action:retry-checks',
        'server:action:keep-changes',
        'server:action:rollback',
      ].includes(id)).map(({ label }) => label),
      ['Copy failure report', 'View full failed output', 'Run checks again', 'Keep changes', 'Roll back update'],
    );
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'server:view-failure');
    await controller.handleKey({ name: 'enter' });
    assert.equal(state.messages.some(({ title }) => title === 'Failed check output'), true);
  } finally {
    await controller.cleanup();
  }
});

test('unconfigured server-backed project selection keeps directory completion and reopens through the server', async () => {
  const root = await tempDir('zipflow-client-project-path-parity-');
  const child = path.join(root, 'child');
  await mkdir(child, { recursive: true });
  const calls = [];
  const baseProject = {
    ...projectResource({ workflowConfigured: false }),
    canonicalPath: root,
  };
  const client = fakeClient({
    calls,
    project: baseProject,
    workflow: { projectId: 'project-1', revision: 0, workflow: null, suggestedWorkflow: null },
    openProjectHandler: async (request, count) => ({
      ...baseProject,
      projectId: `project-${count}`,
      canonicalPath: path.resolve(request.path),
    }),
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: root,
    projectInspector: async (target) => ({
      root: target,
      name: path.basename(target),
      git: false,
      projects: [],
      checks: [],
      deployCandidates: [],
    }),
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });

  try {
    await controller.boot();
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'server:choose-directory');
    await controller.handleKey({ name: 'enter' });
    assert.equal(state.screen, 'project-path-input');
    state.editor.set(path.join(root, 'chil'));
    await controller.handleKey({ name: 'd', printable: true, text: 'd', sequence: 'd' });
    assert.equal(state.pathSuggestions.items.some(({ path: value }) => value === child), true);
    await controller.handleKey({ name: 'tab' });
    await controller.handleKey({ name: 'enter' });
    if (calls.filter(({ method }) => method === 'openProject').length < 2) {
      await controller.handleKey({ name: 'enter' });
    }
    assert.equal(calls.filter(({ method }) => method === 'openProject').length, 2);
    assert.equal(state.project.root, child);
    assert.equal(state.screen, 'new-project');
  } finally {
    await controller.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('server-backed TUI preserves pointer, contextual help, settings, and menu search controls', async () => {
  const root = await tempDir('zipflow-client-navigation-parity-');
  const calls = [];
  const client = fakeClient({
    calls,
    project: {
      ...projectResource({ workflowConfigured: true }),
      canonicalPath: root,
    },
    workflow: { projectId: 'project-1', revision: 3, workflow: { version: 9, checks: [] } },
  });
  const state = createInitialState();
  let helpOpened = false;
  let pointerEnabled = true;
  const controller = new ClientBackedZipflowController(state, {
    cwd: root,
    projectInspector: async () => ({
      root,
      name: 'Fixture',
      git: false,
      technologies: [],
      labels: [],
      projects: [],
      checks: [],
      deployCandidates: [],
    }),
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });
  controller.attachRuntime({
    overlays: {
      help() { helpOpened = true; },
      toast() {},
    },
    togglePointerOverride() {
      pointerEnabled = !pointerEnabled;
      return pointerEnabled;
    },
    invalidate() {},
    exit() {},
  });

  try {
    await controller.boot();
    await controller.showProject();
    await controller.handleKey({ name: 't', ctrl: true });
    assert.match(state.status, /Native text selection enabled/);

    await controller.handleKey({ name: '?', printable: true, text: '?' });
    assert.equal(helpOpened, true);

    await controller.handleKey({ name: 'b', ctrl: true });
    assert.equal(state.screen, 'settings');
    await controller.handleKey({ name: 'b', ctrl: true });
    assert.equal(state.screen, 'home');

    await controller.showHistory();
    assert.deepEqual(
      state.menuItems.slice(0, 3).map(({ id }) => id),
      ['history-type-filter', 'history-status-filter', 'history-analytics'],
    );
    await controller.handleKey({ name: '/', printable: true, text: '/' });
    assert.equal(state.menuSearch.active, true);
    await controller.handleKey({ name: 'r', printable: true, text: 'r', sequence: 'r' });
    assert.equal(state.searchEditor.value, 'r');
    await controller.handleKey({ name: 'enter' });
    assert.equal(state.menuSearch.active, false);
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'history:run-history-1');
    await controller.handleKey({ name: 'enter' });
    assert.equal(state.screen, 'run-details');
    await controller.handleKey({ name: 'escape' });
    assert.equal(state.screen, 'run-history');
  } finally {
    await controller.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('server-backed home preserves the client-owned Create ZIP workflow', async () => {
  const root = await tempDir('zipflow-client-export-parity-');
  const calls = [];
  const client = fakeClient({
    calls,
    project: {
      ...projectResource({ workflowConfigured: true }),
      canonicalPath: root,
    },
    workflow: { projectId: 'project-1', revision: 3, workflow: { version: 9, checks: [] } },
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: root,
    projectInspector: async () => ({
      root,
      name: 'Fixture',
      git: false,
      technologies: [],
      labels: [],
      projects: [],
      checks: [],
      deployCandidates: [],
    }),
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });

  try {
    await controller.boot();
    await controller.showProject();
    const createIndex = state.menuItems.findIndex(({ id }) => id === 'server:create-zip');
    assert.ok(createIndex >= 0);
    state.selectedIndex = createIndex;
    await controller.handleKey({ name: 'enter' });
    assert.equal(state.screen, 'export-mode');
    assert.deepEqual(
      state.menuItems.map(({ id }) => id),
      ['export-tracked', 'export-nonignored', 'export-interactive', 'export-all', 'export-cancel'],
    );
    await controller.handleKey({ name: 'escape' });
    assert.equal(state.screen, 'home');
  } finally {
    await controller.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('server-backed home preserves Repeat last archive and manual deployment actions', async () => {
  const root = await tempDir('zipflow-client-home-actions-parity-');
  const workflow = {
    version: 9,
    name: 'Fixture',
    projectPath: root,
    checks: [],
    deploy: { policy: 'ask', cwd: '.', commandText: 'npm run deploy' },
  };
  const project = {
    ...projectResource({ workflowConfigured: true }),
    canonicalPath: root,
  };
  const historyItems = [{
    runId: 'previous-run',
    kind: 'archive',
    status: 'completed',
    seriesId: 'series-1',
    blob: { blobId: 'sha256:previous', sha256: 'previous' },
  }];
  const repeatCalls = [];
  const deployCalls = [];
  const projectInspector = async () => ({
    root,
    name: 'Fixture',
    git: false,
    projects: [],
    checks: [],
    deployCandidates: [],
  });
  const repeatController = new ClientBackedZipflowController(createInitialState(), {
    cwd: root,
    projectInspector,
    connect: async () => new StandaloneServerConnection({
      client: fakeClient({
        calls: repeatCalls,
        project,
        workflow: { projectId: 'project-1', revision: 3, workflow },
        historyItems,
      }),
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });
  const deployController = new ClientBackedZipflowController(createInitialState(), {
    cwd: root,
    projectInspector,
    connect: async () => new StandaloneServerConnection({
      client: fakeClient({
        calls: deployCalls,
        project,
        workflow: { projectId: 'project-1', revision: 3, workflow },
        historyItems,
      }),
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });

  try {
    await repeatController.boot();
    await repeatController.showProject();
    const repeat = repeatController.state.menuItems.find(({ id }) => id === 'server:repeat-last');
    assert.equal(repeat.disabled, false);
    repeatController.state.selectedIndex = repeatController.state.menuItems.indexOf(repeat);
    await repeatController.handleKey({ name: 'enter' });
    assert.equal(
      repeatCalls.find(({ method }) => method === 'startArchiveRun').draft.blobId,
      'sha256:previous',
    );

    await deployController.boot();
    await deployController.showProject();
    const deploy = deployController.state.menuItems.find(({ id }) => id === 'server:deploy');
    assert.equal(deploy.label, 'Run deployment');
    deployController.state.selectedIndex = deployController.state.menuItems.indexOf(deploy);
    await deployController.handleKey({ name: 'enter' });
    assert.equal(deployCalls.filter(({ method }) => method === 'startDeployRun').length, 1);
  } finally {
    await repeatController.cleanup();
    await deployController.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('full workflow setup UI persists its final draft through the server revision boundary', async () => {
  const root = await tempDir('zipflow-client-setup-parity-');
  const calls = [];
  const workflow = {
    version: 9,
    name: 'Fixture',
    projectPath: root,
    projects: [],
    checks: [],
    policy: { id: 'safe', label: 'Safe' },
    autonomy: { mode: 'manual' },
    archive: { mode: 'overlay' },
    deletion: { scope: 'tracked-only' },
    git: {
      checkpoint: 'never',
      resultCommit: 'never',
      messageStrategy: 'generated',
      fixedMessage: 'zipflow: apply {runId}',
      hooks: 'disabled',
    },
    deploy: { policy: 'disabled', commandText: '', cwd: '.' },
  };
  const client = fakeClient({
    calls,
    project: {
      ...projectResource({ workflowConfigured: true }),
      canonicalPath: root,
    },
    workflow: { projectId: 'project-1', revision: 3, workflow },
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: root,
    createId: sequenceIds('instance-1', 'open-1', 'workflow-save-1'),
    projectInspector: async () => ({
      root,
      name: 'Fixture',
      git: false,
      technologies: [],
      labels: [],
      projects: [],
      checks: [],
      deployCandidates: [],
    }),
    connect: async () => new StandaloneServerConnection({
      client,
      server: null,
      owned: false,
      endpoint: '/tmp/api.sock',
      hello: HELLO,
    }),
  });

  try {
    await controller.boot();
    await controller.beginWorkflowSetup();
    assert.equal(state.screen, 'setup-sections');
    state.draft = structuredClone(workflow);
    controller.showMenu('setup-review', [
      { id: 'save-workflow', label: 'Replace existing workflow' },
    ], 'Review workflow');
    await controller.handleKey({ name: 'enter' });
    const saved = calls.find(({ method }) => method === 'putWorkflow');
    assert.deepEqual(saved.draft, workflow);
    assert.equal(saved.options.ifMatch, 3);
    assert.equal(state.screen, 'archive-input');
  } finally {
    await controller.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
