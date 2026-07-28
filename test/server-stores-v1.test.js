import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { BlobStore } from '../src/server/blob-store.js';
import {
  fingerprintRequest,
  IdempotencyStore,
} from '../src/server/idempotency-store.js';
import { ProjectRegistry } from '../src/server/project-registry.js';

test('project registry collapses canonical path aliases and survives restart', async (t) => {
  const fixture = await temporaryDirectory(t, 'zipflow-project-registry-');
  const project = path.join(fixture, 'project');
  const alias = path.join(fixture, 'alias');
  const storage = path.join(fixture, 'registry');
  await mkdir(project);
  await symlink(project, alias);

  const registry = await new ProjectRegistry({ root: storage }).initialize();
  const first = await registry.open(project, {
    name: 'fixture',
    technologies: ['node'],
    labels: ['Node.js'],
  });
  const second = await registry.open(alias);
  assert.equal(second.projectId, first.projectId);
  assert.equal(second.canonicalPath, first.canonicalPath);
  assert.equal((await registry.list()).length, 1);

  const restarted = await new ProjectRegistry({ root: storage }).initialize();
  assert.deepEqual(await restarted.get(first.projectId), first);
});

test('blob store streams, hashes, deduplicates, and cleans incomplete uploads', async (t) => {
  const fixture = await temporaryDirectory(t, 'zipflow-blob-store-');
  const store = await new BlobStore({
    root: path.join(fixture, 'blobs'),
    maxBytes: 16,
    now: () => new Date('2026-07-28T00:00:00.000Z'),
  }).initialize();
  const content = Buffer.from('PK\u0003\u0004fixture');
  const first = await store.putStream(Readable.from([content.subarray(0, 3), content.subarray(3)]), {
    contentLength: content.length,
    filename: '../../result.zip',
  });
  assert.match(first.blobId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.filename, 'result.zip');
  assert.equal(first.deduplicated, false);

  const second = await store.putStream(Readable.from([content]), {
    contentLength: content.length,
    filename: 'result.zip',
  });
  assert.equal(second.blobId, first.blobId);
  assert.equal(second.deduplicated, true);
  const opened = await store.open(first.blobId);
  assert.equal(opened.record.size, content.length);
  await opened.handle.close();

  await assert.rejects(
    store.putStream(Readable.from([Buffer.alloc(17)]), { filename: 'too-large.zip' }),
    (error) => error?.code === 'BLOB_TOO_LARGE',
  );
  await assert.rejects(
    store.putStream(Readable.from([content]), { contentLength: content.length + 1 }),
    (error) => error?.code === 'CONTENT_LENGTH_MISMATCH',
  );
  assert.deepEqual(await readdir(path.join(fixture, 'blobs', '.incoming')), []);

  const incoming = path.join(fixture, 'blobs', '.incoming');
  await writeFile(path.join(incoming, 'orphan.upload'), 'partial', { mode: 0o600 });
  await new BlobStore({ root: path.join(fixture, 'blobs'), maxBytes: 16 }).initialize();
  assert.deepEqual(await readdir(incoming), []);

  const outside = path.join(fixture, 'outside.upload');
  await writeFile(outside, 'do not remove', { mode: 0o600 });
  await symlink(outside, path.join(incoming, 'unsafe.upload'));
  await assert.rejects(
    new BlobStore({ root: path.join(fixture, 'blobs'), maxBytes: 16 }).initialize(),
    (error) => error?.code === 'SERVER_STORAGE_UNSAFE',
  );
});

test('idempotency receipts replay identical requests and conflict on reuse', async (t) => {
  const fixture = await temporaryDirectory(t, 'zipflow-idempotency-');
  const root = path.join(fixture, 'receipts');
  const store = await new IdempotencyStore({
    root,
    now: () => new Date('2026-07-28T00:00:00.000Z'),
  }).initialize();
  const fingerprint = fingerprintRequest({ method: 'POST', body: { b: 2, a: 1 } });
  assert.equal(
    fingerprint,
    fingerprintRequest({ body: { a: 1, b: 2 }, method: 'POST' }),
  );

  const [left, right] = await Promise.all([
    store.claim({ key: 'request-1', fingerprint }),
    store.claim({ key: 'request-1', fingerprint }),
  ]);
  assert.deepEqual(new Set([left.kind, right.kind]), new Set(['claimed', 'in-progress']));
  const receipt = { status: 201, body: { resourceId: 'resource-1' } };
  await store.complete({ key: 'request-1', fingerprint, receipt });
  const replay = await store.claim({ key: 'request-1', fingerprint });
  assert.equal(replay.kind, 'replay');
  assert.deepEqual(replay.receipt, receipt);
  await assert.rejects(
    store.claim({
      key: 'request-1',
      fingerprint: fingerprintRequest({ method: 'POST', body: { a: 2 } }),
    }),
    (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
  );

  const restarted = await new IdempotencyStore({ root }).initialize();
  assert.equal((await restarted.claim({ key: 'request-1', fingerprint })).kind, 'replay');
  const activeFingerprint = fingerprintRequest({ method: 'POST', body: { active: true } });
  await restarted.claim({ key: 'active-request', fingerprint: activeFingerprint });
  const reconciled = await restarted.reconcileActive();
  assert.equal(reconciled[0].status, 'uncertain');
  assert.equal((await restarted.get('active-request')).status, 'uncertain');
});

async function temporaryDirectory(t, prefix) {
  const target = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(target, { recursive: true, force: true }));
  return target;
}
