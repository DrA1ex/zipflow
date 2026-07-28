import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { EventJournal } from '../src/server/event-journal.js';
import { OperationRegistry } from '../src/server/operation-registry.js';

test('event journal persists monotonic records and reports retention gaps', async (t) => {
  const fixture = await temporaryDirectory(t, 'zipflow-event-journal-');
  const root = path.join(fixture, 'events');
  const journal = await new EventJournal({
    root,
    serverEpoch: 'epoch-one',
    maxEvents: 3,
  }).initialize();
  const observed = [];
  const unsubscribe = journal.subscribe((event) => observed.push(event.sequence), {
    filters: { projectId: 'project-a' },
  });
  await journal.append('project.changed', { projectId: 'project-b', data: { step: 1 } });
  await journal.append('project.changed', { projectId: 'project-a', data: { step: 2 } });
  await journal.append('operation.started', { projectId: 'project-a', operationId: 'operation-a' });
  await journal.append('operation.settled', { projectId: 'project-a', operationId: 'operation-a' });
  unsubscribe();
  assert.deepEqual(observed, [2, 3, 4]);
  assert.deepEqual(journal.replay({ after: 1 }).events.map((event) => event.sequence), [2, 3, 4]);
  assert.equal(journal.replay({ after: 0 }).gap, true);
  assert.equal(journal.replay({ after: 10 }).gap, true);

  const restarted = await new EventJournal({
    root,
    serverEpoch: 'epoch-one',
    maxEvents: 3,
  }).initialize();
  assert.equal((await restarted.append('server.stopping')).sequence, 5);
});

test('high-rate event records can be coalesced without losing durable ordering', async (t) => {
  const fixture = await temporaryDirectory(t, 'zipflow-event-coalesce-');
  const journal = await new EventJournal({
    root: path.join(fixture, 'events'),
    serverEpoch: 'epoch-coalesce',
  }).initialize();
  const first = journal.appendCoalesced('operation.progress', {
    operationId: 'operation-a',
    data: { completed: 1 },
  }, { key: 'progress-a', delayMs: 100 });
  const second = journal.appendCoalesced('operation.progress', {
    operationId: 'operation-a',
    data: { completed: 2 },
  }, { key: 'progress-a', delayMs: 100 });
  await journal.flushCoalesced();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.sequence, right.sequence);
  assert.equal(left.data.completed, 2);
  assert.equal(journal.latestSequence(), 1);
});

test('operation registry serializes per project, defers critical cancellation, and reconciles restart', async (t) => {
  const fixture = await temporaryDirectory(t, 'zipflow-operations-');
  const journal = await new EventJournal({
    root: path.join(fixture, 'events'),
    serverEpoch: 'epoch-operations',
  }).initialize();
  const root = path.join(fixture, 'operations');
  const registry = await new OperationRegistry({ root, journal }).initialize();

  const first = await registry.begin({ projectId: 'project-a', kind: 'archive' });
  await assert.rejects(
    registry.begin({ projectId: 'project-a', kind: 'checks' }),
    (error) => error?.code === 'PROJECT_OPERATION_BUSY',
  );
  const parallel = await registry.begin({ projectId: 'project-b', kind: 'checks' });
  await first.enterCritical('apply');
  const cancellation = await first.requestCancellation();
  assert.equal(cancellation.status, 202);
  assert.equal(cancellation.operation.settlement, 'cancel_deferred');
  assert.equal(first.signal.aborted, false);
  await first.leaveCritical('apply-complete');
  assert.equal(first.signal.aborted, true);
  await first.settle('cancelled');
  await parallel.settle('succeeded');

  const active = await registry.begin({ projectId: 'project-c', kind: 'deploy' });
  assert.equal((await active.snapshot()).settlement, 'active');
  const restarted = await new OperationRegistry({ root, journal }).initialize();
  assert.equal((await restarted.get(active.operationId)).settlement, 'uncertain');
  assert.equal(
    journal.replay({ after: 0 }).events.some((event) => (
      event.type === 'operation.settled' && event.operationId === active.operationId
    )),
    true,
  );
});

async function temporaryDirectory(t, prefix) {
  const target = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(target, { recursive: true, force: true }));
  return target;
}
