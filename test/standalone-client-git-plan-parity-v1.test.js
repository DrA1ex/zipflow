import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { createInitialState } from '../src/app/state.js';
import { showGitBootstrap } from '../src/app/setup-git-init.js';
import { ClientBackedZipflowController } from '../src/standalone/client-controller.js';
import { StandaloneServerConnection } from '../src/standalone/local-server.js';
import { tempDir } from '../test-support/helpers.js';
import {
  fakeClient,
  HELLO,
  projectResource,
  semanticSurface,
  sequenceIds,
} from './standalone-client-fixtures.js';

test('server-backed Git bootstrap keeps the original setup UI while all mutations use project actions', async () => {
  const root = await tempDir('zipflow-client-git-bootstrap-parity-');
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  let gitInitialized = false;
  const calls = [];
  const workflow = {
    version: 9,
    name: 'Fixture',
    projectPath: root,
    projects: [],
    checks: [],
    git: { checkpoint: 'never', resultCommit: 'never', hooks: 'disabled' },
  };
  const client = fakeClient({
    calls,
    project: {
      ...projectResource({ workflowConfigured: false }),
      canonicalPath: root,
    },
    workflow: { projectId: 'project-1', revision: 0, workflow: null, suggestedWorkflow: workflow },
    setupAction: async (actionId) => {
      if (actionId === 'initialize-git') {
        gitInitialized = true;
        return { ok: true };
      }
      if (actionId === 'create-gitignore') return { created: true, addedCount: 4 };
      if (actionId === 'prepare-initial-commit') {
        return {
          ok: true,
          paths: ['package.json'],
          approvedPaths: ['package.json'],
          sensitive: [],
        };
      }
      if (actionId === 'create-initial-commit') {
        return {
          ok: true,
          revision: 'abc1234',
          paths: ['package.json'],
          omittedPaths: [],
        };
      }
      throw new Error(`Unexpected setup action: ${actionId}`);
    },
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: root,
    projectInspector: async () => ({
      root,
      name: 'Fixture',
      git: gitInitialized,
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
    state.draft = structuredClone(workflow);
    showGitBootstrap(controller);
    await controller.handleKey({ name: 'enter' });
    assert.equal(state.screen, 'setup-gitignore');

    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'gitignore-add');
    await controller.handleKey({ name: 'enter' });
    assert.equal(state.screen, 'setup-initial-commit');

    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'initial-commit-default');
    await controller.handleKey({ name: 'enter' });
    assert.equal(state.screen, 'setup-checks');
    assert.deepEqual(
      calls.filter(({ method }) => method === 'performProjectSetupAction')
        .map(({ actionId }) => actionId),
      [
        'initialize-git',
        'create-gitignore',
        'prepare-initial-commit',
        'create-initial-commit',
      ],
    );
  } finally {
    await controller.cleanup();
    await rm(root, { recursive: true, force: true });
  }
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
  assert.equal(state.menuItems[0].id, 'plan-category:updated');
  await controller.activateSelected();
  assert.equal(state.menuItems[0].id, 'plan-file:updated:0');
  await controller.activateSelected();
  state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'plan-file-diff');
  await controller.activateSelected();
  assert.equal(state.screen, 'diff-view');
  assert.equal(state.diffView.diff.rows[0].type, 'remove');
  assert.equal(state.diffView.diff.rows[1].type, 'add');

  const rollback = {
    ...surface.actions[0],
    id: 'rollback',
    kind: 'rollback',
    label: 'Roll back',
    confirmation: 'dangerous',
    inputSchema: null,
  };
  await controller.activateAction(rollback);
  assert.equal(calls.some(({ method }) => method === 'performAction'), false);
  assert.equal(state.menuItems[0].id, 'server:confirm-action');
  assert.equal(state.menuItems[0].disabled, undefined);
  assert.equal(controller.pendingInput?.action?.id, 'rollback');
  await controller.activateSelected();
  assert.equal(
    calls.some(({ method, actionId }) => method === 'performAction' && actionId === 'rollback'),
    true,
  );
  await controller.cleanup();
});

test('legacy plan toggles persist through semantic server actions before apply', async () => {
  const calls = [];
  const surface = semanticSurface();
  const client = fakeClient({
    calls,
    project: projectResource({ workflowConfigured: true }),
    workflow: {
      projectId: 'project-1',
      revision: 3,
      workflow: { version: 9, archive: { mode: 'overlay' }, checks: [] },
    },
    surface,
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: '/project',
    createId: sequenceIds(
      'instance-1',
      'open-1',
      'keep-action-1',
      'approve-action-1',
    ),
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
    state.serverSurface = surface;
    await controller.showPlan();
    await controller.activateSelected();
    await controller.activateSelected();
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'plan-file-keep');
    await controller.activateSelected();
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'plan-file-back');
    await controller.activateSelected();
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'apply-plan');
    await controller.activateSelected();

    assert.deepEqual(
      calls.filter(({ method }) => method === 'performAction')
        .map(({ actionId, input }) => ({ actionId, input })),
      [
        { actionId: 'keep-local', input: { path: 'src/index.js' } },
        { actionId: 'approve-plan', input: {} },
      ],
    );
  } finally {
    await controller.cleanup();
  }
});

test('server-backed run history preserves the legacy changed-files and stored-diff navigation', async () => {
  const calls = [];
  const client = fakeClient({
    calls,
    project: projectResource({ workflowConfigured: true }),
    workflow: {
      projectId: 'project-1',
      revision: 3,
      workflow: { version: 9, archive: { mode: 'overlay' }, checks: [] },
    },
    historyItems: [{
      runId: 'run-history-1',
      kind: 'archive',
      status: 'completed',
      createdAt: '2026-07-29T00:00:00.000Z',
      summary: { projectName: 'Fixture' },
    }],
    reportHandler: async (runId) => ({
      runId,
      kind: 'archive',
      status: 'completed',
      project: { projectId: 'project-1', name: 'Fixture' },
      workflow: { revision: 3, name: 'Fixture workflow' },
      archive: { filename: 'result.zip', size: 6, fileCount: 1 },
      plan: { counts: { created: 0, updated: 1, deleted: 0 } },
      checks: { passed: 1, failed: 0, ok: true },
      decisions: [{
        gate: 'plan',
        action: 'approve-plan',
        executionStatus: 'executed',
        source: 'llm',
        model: 'fixture-model',
        summary: 'Routine update approved.',
        allowedActions: ['approve-plan', 'cancel-run'],
      }],
      autonomy: { mode: 'guarded' },
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:01.000Z',
      completedAt: '2026-07-29T00:00:01.000Z',
    }),
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: '/project',
    createId: sequenceIds('instance-1', 'open-1'),
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
    await controller.showHistory();
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'history:run-history-1');
    await controller.activateSelected();
    assert.equal(state.screen, 'run-details');
    assert.equal(controller.runId, 'run-history-1');

    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'view-run-files');
    await controller.activateSelected();
    assert.equal(state.screen, 'run-file-groups');
    assert.equal(state.menuItems[0].id, 'run-group:updated');

    await controller.activateSelected();
    assert.equal(state.screen, 'run-file-list');
    assert.equal(state.menuItems[0].diffPath, 'src/index.js');

    await controller.activateSelected();
    assert.equal(state.screen, 'diff-view');
    assert.equal(state.diffView.diff.rows[0].type, 'remove');
    assert.equal(state.diffView.diff.rows[1].type, 'add');
    assert.equal(
      calls.some(({ method, runId }) => method === 'getPlan' && runId === 'run-history-1'),
      true,
    );

    await controller.handleKey({ name: 'escape' });
    assert.equal(state.screen, 'run-file-list');
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'run-groups-back');
    await controller.activateSelected();
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'run-files-back');
    await controller.activateSelected();
    assert.equal(state.screen, 'run-details');
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'view-run-decisions');
    await controller.activateSelected();
    assert.equal(state.screen, 'run-decisions');
    assert.equal(state.menuItems[0].id, 'run-decision:0');
    await controller.activateSelected();
    assert.equal(state.screen, 'run-decisions');
    assert.equal(
      calls.some(({ method }) => method === 'performAction'),
      false,
    );
  } finally {
    await controller.cleanup();
  }
});

test('server-backed archive safety and conflict review reuse the legacy interactive screens', async () => {
  const calls = [];
  let surface = {
    ...semanticSurface(),
    id: 'archive-safety:run-1',
    kind: 'archive_safety',
    actions: [
      action('reinterpret-as-overlay', 'Recheck as overlay'),
      action('acknowledge-archive-safety', 'Continue'),
      action('cancel-run', 'Cancel run'),
    ],
  };
  const client = fakeClient({
    calls,
    project: projectResource({ workflowConfigured: true }),
    workflow: {
      projectId: 'project-1',
      revision: 3,
      workflow: { version: 9, archive: { mode: 'snapshot' }, checks: [] },
    },
    surface,
    reportHandler: async (runId) => ({
      runId,
      status: 'waiting_action',
      project: { projectId: 'project-1', name: 'Fixture' },
      workflow: { revision: 3, name: 'Fixture workflow' },
      archiveSafety: {
        warnings: [{
          code: 'SNAPSHOT_SHRINK',
          severity: 'warning',
          message: 'Snapshot is much smaller: Review removals before applying',
        }],
      },
      plan: { counts: { created: 0, updated: 0, deleted: 0, conflicts: 0 } },
      decisions: [],
    }),
    planHandler: async (_runId, query) => ({
      items: query.group === 'conflicts'
        ? [{
            path: 'src/conflict.js',
            kind: 'updated',
            reason: 'Local work overlaps the archive update.',
            decision: null,
          }]
        : [],
      counts: {
        created: 0,
        updated: 0,
        deleted: 0,
        preserved: 0,
        unchanged: 0,
        skipped: 0,
        conflicts: query.group === 'conflicts' ? 1 : 0,
      },
      nextCursor: null,
    }),
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: '/project',
    createId: sequenceIds(
      'instance-1',
      'open-1',
      'reinterpret-1',
      'resolve-1',
      'approve-1',
    ),
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
    assert.equal(state.screen, 'archive-safety');
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'recheck-as-overlay');
    assert.notEqual(state.selectedIndex, -1);
    await controller.activateSelected();
    assert.equal(
      calls.some(({ method, actionId }) => (
        method === 'performAction' && actionId === 'reinterpret-as-overlay'
      )),
      true,
    );

    Object.assign(surface, {
      ...semanticSurface(),
      id: 'conflicts:run-1',
      kind: 'conflict_summary',
      actions: [
        action('resolve-conflict', 'Resolve conflict'),
        action('approve-plan', 'Apply plan'),
        action('cancel-run', 'Cancel run'),
      ],
    });
    await controller.refreshRun();
    assert.equal(state.screen, 'conflict-summary');
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'choose-conflicts');
    await controller.activateSelected();
    assert.equal(state.screen, 'conflict-file');
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'conflict-use-archive');
    await controller.activateSelected();
    assert.equal(state.screen, 'plan-review');
    state.selectedIndex = state.menuItems.findIndex(({ id }) => id === 'apply-plan');
    await controller.activateSelected();
    assert.deepEqual(
      calls.filter(({ method, actionId }) => (
        method === 'performAction' && ['resolve-conflict', 'approve-plan'].includes(actionId)
      )).map(({ actionId, input }) => ({ actionId, input })),
      [
        {
          actionId: 'resolve-conflict',
          input: { path: 'src/conflict.js', decision: 'archive' },
        },
        { actionId: 'approve-plan', input: {} },
      ],
    );
  } finally {
    await controller.cleanup();
  }
});

test('server-backed commit choice keeps the legacy candidate, edit, and skip menu contract', async () => {
  const calls = [];
  const surface = {
    ...semanticSurface(),
    id: 'commit:run-1',
    kind: 'commit_choice',
    sections: [{
      id: 'commit',
      kind: 'commit',
      suggestedMessage: 'Apply result archive',
      candidates: [{
        id: 'metadata',
        label: 'Archive metadata',
        message: 'Apply fixture update',
        detail: 'Read from the uploaded archive.',
      }],
    }],
    actions: [
      action('commit', 'Create commit'),
      action('prepare-commit', 'Edit message'),
      action('continue-without-commit', 'Continue without commit'),
    ],
  };
  const client = fakeClient({
    calls,
    project: projectResource({ workflowConfigured: true }),
    workflow: {
      projectId: 'project-1',
      revision: 3,
      workflow: { version: 9, archive: { mode: 'overlay' }, checks: [] },
    },
    surface,
  });
  const state = createInitialState();
  const controller = new ClientBackedZipflowController(state, {
    cwd: '/project',
    createId: sequenceIds('instance-1', 'open-1', 'commit-1'),
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
    assert.equal(state.screen, 'commit');
    assert.deepEqual(
      state.menuItems.map(({ id }) => id),
      [
        'server:commit-candidate:metadata',
        'server:edit-commit-message',
        'server:skip-commit',
      ],
    );
    await controller.activateSelected();
    assert.deepEqual(
      calls.filter(({ method }) => method === 'performAction')
        .map(({ actionId, input }) => ({ actionId, input })),
      [{ actionId: 'commit', input: { message: 'Apply fixture update' } }],
    );
  } finally {
    await controller.cleanup();
  }
});

function action(id, label) {
  return {
    id,
    kind: id.replaceAll('-', '_'),
    label,
    description: label,
    enabled: true,
    disabledReason: null,
    risk: 'project_write',
    confirmation: 'explicit',
    inputSchema: null,
    presentation: { role: 'primary' },
  };
}
