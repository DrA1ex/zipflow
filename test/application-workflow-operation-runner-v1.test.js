import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowOperationRunner } from '../src/application/workflow-operation-runner.js';

test('archive inspection durably publishes attention before events', async () => {
  const fixture = runnerFixture({ operationKind: 'archive_inspection' });
  fixture.dependencies.inspectArchive = async () => ({
    outcome: 'waiting_action',
    attention: 'archive_root',
    executable: {
      ...fixture.session.executionManifest,
      binding: {
        ...fixture.session.executionManifest.binding,
        temporaryRoot: '/private/tmp/run-1',
      },
      rootReview: { prompt: true },
      plan: null,
      decisions: [],
      metadata: null,
      safety: null,
      patch: null,
    },
    public: {
      archiveRootChoices: [{ id: 'nested', label: 'Nested project' }],
      archiveSafety: null,
      plan: null,
    },
  });
  const final = await fixture.run('archive_inspection');

  assert.equal(final.run.status, 'waiting_action');
  assert.equal(final.publicSummary.run.attention, 'archive_root');
  assert.equal(final.publicSummary.operation, null);
  assert.equal(final.executionManifest.binding.temporaryRoot, '/private/tmp/run-1');
  assert.equal(JSON.stringify(final.publicSummary).includes('/private/'), false);
  assert.equal(fixture.savedLegacy.status, 'planned');
  assert.deepEqual(finalOrder(fixture.order), [
    'session:update', 'settle:succeeded', 'event:surface.changed', 'event:run.attention',
  ]);
});

test('apply is critical, runs selected checks, and bounds durable output', async () => {
  const fixture = runnerFixture({
    operationKind: 'apply',
    workflow: workflow({
      checks: [{ id: 'lint', name: 'Lint', selected: true, required: true }],
      git: { resultCommit: 'ask' },
    }),
  });
  fixture.dependencies.applyPlan = async () => {
    fixture.order.push('runner:apply');
    return {
      applied: {
        paths: ['src/file.js'], changedPaths: ['src/file.js'],
        counts: { created: 1, updated: 0, deleted: 0 },
        excludedPaths: [], backupPath: '/private/backups/run-1',
        backupAvailable: true, skippedConflicts: [], preservedPaths: [],
      },
      managedHistory: { before: [], after: ['src/file.js'] },
      transaction: { applied: [] },
    };
  };
  const noisyOutput = `\u001b[31m${'x'.repeat(70_000)}\u0000`;
  fixture.dependencies.runChecks = async () => {
    fixture.order.push('runner:checks');
    return {
      checks: {
        ok: false, passed: 0, failed: 1, skipped: 0,
        results: [{
          id: 'lint', name: 'Lint', ok: false, required: true, code: 1,
          cwd: '/private/project', commandText: 'secret command',
          stdout: '', stderr: '/private/project failed', durationMs: 12,
        }],
      },
      output: noisyOutput,
    };
  };
  const final = await fixture.run('apply');

  assert.equal(final.run.status, 'waiting_action');
  assert.equal(final.publicSummary.run.attention, 'checks_failed');
  assert.equal(final.publicSummary.checks.results[0].cwd, null);
  assert.equal(JSON.stringify(final.publicSummary).includes('/private/'), false);
  assert.equal(JSON.stringify(final.publicSummary).includes('secret command'), false);
  assert.equal(fixture.savedLegacy.applied.backupPath, '/private/backups/run-1');
  assert.equal(fixture.savedLegacy.status, 'checks_failed');
  assert.equal(fixture.appended.length, 1);
  assert.equal(fixture.appended[0].text.length, 64 * 1024);
  assert.equal(fixture.appended[0].text.includes('\u001b'), false);
  assert.equal(fixture.appended[0].truncated, true);
  assert.deepEqual(fixture.order.slice(0, 4), [
    'critical:enter', 'runner:apply', 'critical:leave', 'runner:checks',
  ]);
  assert.deepEqual(finalOrder(fixture.order), [
    'session:update', 'settle:succeeded', 'event:surface.changed', 'event:run.attention',
  ]);
});

test('commit, deployment, and rollback map to semantic durable states', async (t) => {
  await t.test('commit waits for configured deployment', async () => {
    const fixture = runnerFixture({
      operationKind: 'commit',
      workflow: workflow({ deploy: { policy: 'ask', commandText: 'private-deploy-command', cwd: '.' } }),
      privateChanges: { applied: { paths: ['file.txt'], changedPaths: ['file.txt'] } },
    });
    fixture.dependencies.commitRun = async () => ({
      revision: 'abc123', message: 'Apply update', strategy: 'create-new',
      paths: ['file.txt'], omittedPaths: [],
    });
    const final = await fixture.run('commit', { message: 'Apply update' });
    assert.equal(final.run.status, 'waiting_action');
    assert.equal(final.publicSummary.run.attention, 'deploy');
    assert.equal(fixture.savedLegacy.commit.revision, 'abc123');
  });

  await t.test('failed deployment remains an explicit deploy choice', async () => {
    const fixture = runnerFixture({
      operationKind: 'deploy',
      workflow: workflow({ deploy: { policy: 'ask', commandText: 'configured', cwd: '.' } }),
    });
    fixture.dependencies.deployRun = async ({ onProgress }) => {
      onProgress({ output: 'progress\n' });
      return {
        ok: false, code: 2, stdout: 'stdout\n', stderr: 'stderr\n',
        commandText: 'private-deploy-command', cwd: '.',
      };
    };
    const final = await fixture.run('deploy');
    assert.equal(final.run.status, 'waiting_action');
    assert.equal(final.publicSummary.run.attention, 'deploy');
    assert.equal(final.publicSummary.deployment.status, 'failed');
    assert.equal(JSON.stringify(final.publicSummary).includes('private-deploy-command'), false);
    assert.equal(fixture.savedLegacy.status, 'deploy_failed');
    assert.match(fixture.appended[0].text, /stderr/);
  });

  await t.test('rollback is terminal and records restored count', async () => {
    const fixture = runnerFixture({
      operationKind: 'rollback',
      privateChanges: {
        applied: { paths: ['file.txt'], changedPaths: ['file.txt'], backupAvailable: true },
        managedHistory: { before: [] },
      },
    });
    fixture.dependencies.rollbackRun = async () => ({
      status: 'completed', restored: 2, at: '2026-07-28T10:00:00.000Z',
    });
    const final = await fixture.run('rollback');
    assert.equal(final.run.status, 'rolled_back');
    assert.equal(final.publicSummary.rollback.restored, 2);
    assert.equal(final.publicSummary.operation, null);
    assert.equal(fixture.savedLegacy.status, 'rolled_back');
    assert.deepEqual(finalOrder(fixture.order), [
      'session:update', 'settle:succeeded', 'event:surface.changed', 'event:run.rolled_back',
    ]);
  });
});

test('failures are sanitized and cancellation settles as cancelled', async (t) => {
  await t.test('internal failure', async () => {
    const fixture = runnerFixture({ operationKind: 'checks', runKind: 'checks' });
    fixture.dependencies.runChecks = async () => {
      throw Object.assign(new Error('secret at /private/project/token'), { code: 'CHECK_EXEC_FAILED' });
    };
    await assert.rejects(fixture.run('checks'), /secret at/);
    assert.equal(fixture.current.run.status, 'failed');
    assert.equal(fixture.current.publicSummary.error.code, 'CHECK_EXEC_FAILED');
    assert.equal(fixture.current.publicSummary.error.message.includes('/private/'), false);
    assert.deepEqual(finalOrder(fixture.order), [
      'session:update', 'settle:failed', 'event:surface.changed', 'event:run.failed',
    ]);
  });

  await t.test('cancellation', async () => {
    const fixture = runnerFixture({ operationKind: 'checks', runKind: 'checks' });
    fixture.dependencies.runChecks = async () => {
      throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    };
    await assert.rejects(fixture.run('checks'), /cancelled/);
    assert.equal(fixture.current.run.status, 'cancelled');
    assert.equal(fixture.current.publicSummary.error, null);
    assert.ok(fixture.order.includes('settle:cancelled'));
  });
});

function runnerFixture({
  operationKind,
  runKind = 'archive',
  workflow: configuredWorkflow = workflow(),
  privateChanges = {},
} = {}) {
  const order = [];
  const appended = [];
  const controller = new AbortController();
  const session = {
    version: 1,
    revision: 4,
    binding: {
      projectId: 'project-1', projectPath: '/private/project', workflowRevision: 3,
      blobId: null, blobSha256: null,
    },
    run: {
      runId: 'run-1', kind: runKind, operationId: 'operation-1', status: operationKind,
      createdAt: '2026-07-28T09:00:00.000Z', updatedAt: '2026-07-28T09:00:00.000Z',
    },
    executionManifest: {
      version: 1,
      binding: {
        runId: 'run-1', projectId: 'project-1', projectPath: '/private/project',
        workflowRevision: 3,
        blob: {
          blobId: `sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64), size: 10,
          filename: 'update.zip', createdAt: '2026-07-28T09:00:00.000Z',
          path: '/private/blobs/archive.zip',
        },
      },
      workflow: configuredWorkflow,
      ...structuredClone(privateChanges),
    },
    publicSummary: {
      project: { id: 'project-1', name: 'Fixture' },
      workflow: { configured: true, name: 'Workflow' },
      run: { id: 'run-1', status: operationKind, attention: null },
      operation: { id: 'operation-1', kind: operationKind, settlement: 'active' },
    },
    outputs: [],
    actions: [],
  };
  let current = structuredClone(session);
  let savedLegacy = null;
  const dependencies = {};
  const sessions = {
    get: async () => structuredClone(current),
    update: async ({ expectedRevision, changes }) => {
      assert.equal(expectedRevision, current.revision);
      order.push('session:update');
      current = {
        ...current,
        revision: current.revision + 1,
        run: {
          ...current.run,
          status: changes.status ?? current.run.status,
          operationId: changes.operationId === undefined ? current.run.operationId : changes.operationId,
        },
        executionManifest: changes.executionManifest ?? current.executionManifest,
        publicSummary: changes.publicSummary ?? current.publicSummary,
      };
      return structuredClone(current);
    },
    appendOutput: async (record) => {
      assert.equal(record.expectedRevision, current.revision);
      order.push('session:output');
      appended.push(structuredClone(record));
      current = { ...current, revision: current.revision + 1 };
      return structuredClone(current);
    },
  };
  const handle = {
    operationId: 'operation-1', signal: controller.signal,
    enterCritical: async () => order.push('critical:enter'),
    leaveCritical: async () => order.push('critical:leave'),
    settle: async (settlement) => order.push(`settle:${settlement}`),
  };
  const journal = {
    append: async (type) => order.push(`event:${type}`),
  };
  const baseDependencies = {
    sessions, journal,
    discoverProject: async () => ({ root: '/private/project', name: 'Fixture' }),
    loadLegacyRun: async () => ({
      version: 9, id: 'run-1', projectPath: '/private/project', status: 'created',
      createdAt: '2026-07-28T09:00:00.000Z',
    }),
    saveLegacyRun: async (legacy) => {
      order.push('legacy:save');
      savedLegacy = structuredClone(legacy);
      return legacy;
    },
  };
  return {
    session,
    order,
    appended,
    dependencies,
    get current() { return current; },
    get savedLegacy() { return savedLegacy; },
    run(kind, input = {}) {
      const runner = new WorkflowOperationRunner({ ...baseDependencies, ...dependencies });
      return runner.run({ handle, launch: { runId: 'run-1', kind, input } });
    },
  };
}

function workflow(changes = {}) {
  return {
    name: 'Workflow', checks: [], git: { resultCommit: 'never' },
    deploy: { policy: 'disabled', commandText: '', cwd: '.' },
    ...structuredClone(changes),
  };
}

function finalOrder(order) {
  return order.filter((item) => item === 'session:update'
    || item.startsWith('settle:') || item.startsWith('event:'));
}
