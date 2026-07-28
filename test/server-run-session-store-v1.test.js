import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { fingerprintRequest } from '../src/server/idempotency-store.js';
import {
  MAX_STORED_OUTPUT_RECORD_BYTES,
  RunSessionStore,
} from '../src/server/run-session-store.js';
import { RUN_SESSION_FILENAME } from '../src/server/run-session-model.js';

test('run session sidecar is durable, private, and coexists with legacy history files', async (t) => {
  const fixture = await setupRun(t, 'run-sidecar');
  const legacyBefore = await readFile(fixture.legacyPath, 'utf8');
  const store = await new RunSessionStore({ runsRoot: fixture.runsRoot, now: tickingClock() }).initialize();
  const created = await store.create(sessionOptions(fixture));

  assert.equal(created.revision, 1);
  assert.equal(created.binding.projectPath, fixture.projectPath);
  assert.equal(created.executionManifest.created[0].sourcePath, fixture.sourcePath);
  assert.notDeepEqual(created.executionManifest, created.publicSummary);
  const sidecarPath = path.join(fixture.runDirectory, RUN_SESSION_FILENAME);
  assert.equal((await lstat(sidecarPath)).mode & 0o077, 0);
  assert.equal(await readFile(fixture.legacyPath, 'utf8'), legacyBefore);

  const restarted = await new RunSessionStore({ runsRoot: fixture.runsRoot }).initialize();
  assert.deepEqual(await restarted.get(fixture.runId), created);
  assert.deepEqual((await restarted.list({ projectId: 'project-fixture' })).map((item) => item.run.runId), [fixture.runId]);
  assert.equal(JSON.parse(await readFile(fixture.legacyPath, 'utf8')).archivePath, '/legacy/archive.zip');
});

test('per-run CAS serializes concurrent writes and preserves immutable binding', async (t) => {
  const fixture = await setupRun(t, 'run-cas');
  const store = await new RunSessionStore({ runsRoot: fixture.runsRoot, now: tickingClock() }).initialize();
  const secondStore = await new RunSessionStore({ runsRoot: fixture.runsRoot, now: tickingClock() }).initialize();
  await store.create(sessionOptions(fixture));

  const attempts = await Promise.allSettled([
    store.update({ runId: fixture.runId, expectedRevision: 1, changes: { status: 'inspecting' } }),
    secondStore.update({ runId: fixture.runId, expectedRevision: 1, changes: { status: 'checking' } }),
  ]);
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = attempts.find(({ status }) => status === 'rejected');
  assert.equal(rejected.reason.code, 'STALE_REVISION');
  assert.equal(rejected.reason.details.currentRevision, 2);

  await assert.rejects(
    store.update({
      runId: fixture.runId,
      expectedRevision: 2,
      changes: { binding: { projectId: 'attacker' } },
    }),
    (error) => error?.code === 'IMMUTABLE_RUN_BINDING',
  );
  await assert.rejects(
    store.update({
      runId: fixture.runId,
      expectedRevision: 2,
      changes: { executionManifest: { created: [{ path: '../escape.txt' }] } },
    }),
    (error) => error?.code === 'INVALID_MANIFEST_PATH',
  );
  assert.equal((await store.get(fixture.runId)).revision, 2);
  assert.equal((await store.get(fixture.runId)).binding.projectId, 'project-fixture');
});

test('output records are durable, ordered, bounded, and require CAS', async (t) => {
  const fixture = await setupRun(t, 'run-output');
  const store = await new RunSessionStore({ runsRoot: fixture.runsRoot, now: tickingClock() }).initialize();
  await store.create(sessionOptions(fixture));
  const oversized = `before-${'é'.repeat(MAX_STORED_OUTPUT_RECORD_BYTES)}-after`;
  const first = await store.appendOutput({
    runId: fixture.runId, expectedRevision: 1, source: 'checks', stream: 'stdout',
    checkId: 'check-node', text: oversized,
  });
  assert.equal(first.revision, 2);
  assert.equal(first.outputs[0].sequence, 1);
  assert.equal(first.outputs[0].truncated, true);
  assert.ok(first.outputs[0].omittedBytes > 0);
  assert.ok(Buffer.byteLength(first.outputs[0].text) <= MAX_STORED_OUTPUT_RECORD_BYTES);
  assert.doesNotMatch(first.outputs[0].text, /\uFFFD/);

  await assert.rejects(
    store.appendOutput({ runId: fixture.runId, expectedRevision: 1, source: 'deploy', text: 'stale' }),
    (error) => error?.code === 'STALE_REVISION',
  );
  const restarted = await new RunSessionStore({ runsRoot: fixture.runsRoot }).initialize();
  assert.deepEqual((await restarted.get(fixture.runId)).outputs, first.outputs);
});

test('action intents and receipts survive restart and gate uncertain dispatches', async (t) => {
  const fixture = await setupRun(t, 'run-actions');
  const clock = tickingClock();
  const store = await new RunSessionStore({ runsRoot: fixture.runsRoot, now: clock }).initialize();
  await store.create(sessionOptions(fixture));
  const fingerprint = fingerprintRequest({ action: 'approve-plan', input: {} });
  const intent = await store.recordActionIntent({
    runId: fixture.runId, expectedRevision: 1, actionIntentId: 'intent-1',
    actionId: 'approve-plan', idempotencyKey: 'key-1', requestFingerprint: fingerprint,
    surfaceRevision: 1, input: {},
  });
  assert.equal(intent.revision, 2);
  assert.equal((await store.listRecoveryActions(fixture.runId))[0].recovery, 'dispatch_pending');

  const replayedIntent = await store.recordActionIntent({
    runId: fixture.runId, expectedRevision: 2, actionIntentId: 'intent-1',
    actionId: 'approve-plan', idempotencyKey: 'key-1', requestFingerprint: fingerprint,
    surfaceRevision: 1, input: {},
  });
  assert.equal(replayedIntent.revision, 2);
  const dispatched = await store.markActionDispatched({
    runId: fixture.runId, expectedRevision: 2, actionIntentId: 'intent-1',
  });
  assert.equal(dispatched.revision, 3);

  const restarted = await new RunSessionStore({ runsRoot: fixture.runsRoot, now: clock }).initialize();
  assert.equal((await restarted.listRecoveryActions(fixture.runId))[0].recovery, 'reconcile_required');
  const uncertain = await restarted.recordActionReceipt({
    runId: fixture.runId, expectedRevision: 3, actionIntentId: 'intent-1',
    settlement: 'uncertain', error: { code: 'CRASH', message: 'lost acknowledgement' },
  });
  assert.equal(uncertain.actions[0].receipt.settlement, 'uncertain');
  assert.equal((await restarted.listRecoveryActions(fixture.runId))[0].recovery, 'reconcile_required');

  const reconciled = await restarted.reconcileActionReceipt({
    runId: fixture.runId, expectedRevision: 4, actionIntentId: 'intent-1',
    settlement: 'succeeded', response: { applied: true }, evidence: { operationId: 'operation-1' },
  });
  assert.equal(reconciled.revision, 5);
  assert.equal(reconciled.actions[0].receipt.reconciled, true);
  assert.equal(reconciled.actions[0].receipt.evidence.previousSettlement, 'uncertain');
  assert.deepEqual(await restarted.listRecoveryActions(fixture.runId), []);
});

test('action settlement cannot claim success before dispatch and idempotency keys stay unique', async (t) => {
  const fixture = await setupRun(t, 'run-action-guards');
  const store = await new RunSessionStore({ runsRoot: fixture.runsRoot, now: tickingClock() }).initialize();
  await store.create(sessionOptions(fixture));
  const fingerprint = fingerprintRequest({ action: 'finish' });
  await store.recordActionIntent({
    runId: fixture.runId, expectedRevision: 1, actionIntentId: 'intent-1', actionId: 'finish',
    idempotencyKey: 'same-key', requestFingerprint: fingerprint, surfaceRevision: 1,
  });
  await assert.rejects(
    store.recordActionReceipt({
      runId: fixture.runId, expectedRevision: 2, actionIntentId: 'intent-1', settlement: 'succeeded',
    }),
    (error) => error?.code === 'ACTION_NOT_DISPATCHED',
  );
  await assert.rejects(
    store.recordActionIntent({
      runId: fixture.runId, expectedRevision: 2, actionIntentId: 'intent-2', actionId: 'finish',
      idempotencyKey: 'same-key', requestFingerprint: fingerprint, surfaceRevision: 2,
    }),
    (error) => error?.code === 'ACTION_INTENT_CONFLICT',
  );
  assert.equal((await store.get(fixture.runId)).revision, 2);
});

test('sidecars require an existing real run directory', async (t) => {
  const root = await temporaryDirectory(t, 'zipflow-run-sidecar-safety-');
  const runsRoot = path.join(root, 'runs');
  await mkdir(runsRoot, { mode: 0o700 });
  const store = await new RunSessionStore({ runsRoot }).initialize();
  const missing = sessionOptions({
    runId: 'missing', projectPath: path.join(root, 'project'), sourcePath: path.join(root, 'source'),
  });
  await assert.rejects(store.create(missing), (error) => error?.code === 'RUN_DIRECTORY_NOT_FOUND');

  const outside = path.join(root, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, path.join(runsRoot, 'linked'));
  await assert.rejects(
    store.create(sessionOptions({ runId: 'linked', projectPath: path.join(root, 'project'), sourcePath: path.join(root, 'source') })),
    (error) => error?.code === 'SERVER_STORAGE_UNSAFE',
  );
});

async function setupRun(t, runId) {
  const root = await temporaryDirectory(t, 'zipflow-run-sidecar-');
  const runsRoot = path.join(root, 'runs');
  const runDirectory = path.join(runsRoot, runId);
  const projectPath = path.join(root, 'project');
  const sourcePath = path.join(root, 'extracted', 'src', 'app.js');
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await mkdir(projectPath, { recursive: true });
  const legacyPath = path.join(runDirectory, 'report.json');
  await writeFile(legacyPath, `${JSON.stringify({ id: runId, projectPath, archivePath: '/legacy/archive.zip' }, null, 2)}\n`);
  return { root, runsRoot, runDirectory, runId, projectPath, sourcePath, legacyPath };
}

function sessionOptions(fixture) {
  const hash = 'a'.repeat(64);
  return {
    runId: fixture.runId,
    binding: {
      projectId: 'project-fixture', projectPath: fixture.projectPath, workflowRevision: 7,
      blobId: `sha256:${hash}`, blobSha256: hash,
    },
    kind: 'archive',
    seriesId: 'series-1',
    operationId: 'operation-1',
    status: 'created',
    correlation: { producer: 'chatgpt-bridge', workflowId: 'workflow-1', requestId: 'request-1' },
    executionManifest: {
      created: [{
        kind: 'created', path: 'src/app.js', sourcePath: fixture.sourcePath,
        currentPath: path.join(fixture.projectPath, 'src', 'app.js'), beforeHash: null, afterHash: hash,
      }],
      updated: [], deleted: [], preserved: [], unchanged: [], skipped: [], conflicts: [],
      counts: { created: 1, updated: 0, deleted: 0 },
    },
    publicSummary: { projectName: 'Fixture', workflowName: 'Workflow', archiveName: 'archive.zip' },
  };
}

async function temporaryDirectory(t, prefix) {
  const target = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(target, { recursive: true, force: true }));
  return target;
}

function tickingClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 28, 0, 0, tick++));
}
