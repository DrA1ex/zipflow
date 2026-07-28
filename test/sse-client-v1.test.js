import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  SseParser,
  SseProtocolError,
  ZipflowEventClient,
  buildEventStreamPath,
  parseSse,
  parseZipflowSseRecord,
} from 'zipflow/client';
import {
  formatConformanceSseEvent,
  getConformanceFixture,
} from 'zipflow/protocol';

test('incremental SSE parser handles BOM, CRLF splits, comments, retry, and multiline data', () => {
  const source = [
    '\ufeff: heartbeat\r\n',
    'retry: 2500\r\n',
    'id: 7\r\n',
    'event: operation.progress\r\n',
    'data: {"serverEpoch":"epoch",\r\n',
    'data: "sequence":7,"projectId":"project","runId":"run","operationId":"operation",',
    '"revision":1,"data":{"phase":"checks"}}\r\n\r\n',
  ].join('');
  const bytes = Buffer.from(source);
  const parser = new SseParser();
  const records = [
    ...parser.push(bytes.subarray(0, 1)),
    ...parser.push(bytes.subarray(1, 17)),
    ...parser.push(bytes.subarray(17, 42)),
    ...parser.push(bytes.subarray(42)),
    ...parser.finish(),
  ];
  assert.equal(records.length, 1);
  assert.equal(records[0].retry, 2500);
  const event = parseZipflowSseRecord(records[0]);
  assert.equal(event.type, 'operation.progress');
  assert.equal(event.sequence, 7);
  assert.equal(event.data.phase, 'checks');
});

test('SSE parser dispatches a final record without a trailing blank line and rejects mismatched ids', () => {
  const event = getConformanceFixture('sseReplay')[0];
  const text = formatConformanceSseEvent(event).trimEnd();
  const [record] = parseSse(text);
  assert.equal(parseZipflowSseRecord(record).sequence, event.sequence);
  assert.throws(() => parseZipflowSseRecord({ ...record, id: '999' }), SseProtocolError);
});

test('event client replays monotonic events after Last-Event-ID with encoded filters', async () => {
  const replay = getConformanceFixture('sseReplay').slice(0, 3);
  const body = replay.map(formatConformanceSseEvent).join('');
  let observed;
  const httpClient = {
    async openStream(requestPath, options) {
      observed = { requestPath, options };
      const response = Readable.from([
        Buffer.from(body.slice(0, 37)),
        Buffer.from(body.slice(37, 151)),
        Buffer.from(body.slice(151)),
      ]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/event-stream; charset=utf-8' };
      return response;
    },
  };
  const client = new ZipflowEventClient({ httpClient });
  const received = [];
  for await (const event of client.subscribe({
    projectId: 'project with spaces',
    runId: 'run/one',
    lastEventId: replay[0].sequence - 1,
  })) received.push(event);

  assert.deepEqual(received.map((event) => event.sequence), replay.map((event) => event.sequence));
  assert.equal(observed.options.headers['last-event-id'], String(replay[0].sequence - 1));
  assert.equal(observed.requestPath, '/v1/events?projectId=project+with+spaces&runId=run%2Fone');
});

test('stream.gap is yielded once and terminates the subscription for full resynchronization', async () => {
  const gap = getConformanceFixture('sseGap');
  const afterGap = getConformanceFixture('sseReplay').at(-1);
  afterGap.sequence = gap.sequence + 1;
  const body = `${formatConformanceSseEvent(gap)}${formatConformanceSseEvent(afterGap)}`;
  const response = Readable.from([body]);
  response.statusCode = 200;
  response.headers = { 'content-type': 'text/event-stream' };
  const client = new ZipflowEventClient({ httpClient: { async openStream() { return response; } } });
  const received = [];
  for await (const event of client.events({ lastEventId: gap.data.requestedAfter })) received.push(event);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'stream.gap');
  assert.equal(received[0].data.retainedFrom, 84);
});

test('event client rejects replay regressions and server epoch changes', async () => {
  const first = getConformanceFixture('sseReplay')[0];
  const duplicate = { ...first, data: { ...first.data } };
  const response = Readable.from([`${formatConformanceSseEvent(first)}${formatConformanceSseEvent(duplicate)}`]);
  response.statusCode = 200;
  response.headers = { 'content-type': 'text/event-stream' };
  const client = new ZipflowEventClient({ httpClient: { async openStream() { return response; } } });
  await assert.rejects(async () => {
    for await (const event of client.events()) void event;
  }, /does not advance cursor/);

  const changedEpoch = { ...first, sequence: first.sequence + 1, serverEpoch: 'another-epoch' };
  const responseTwo = Readable.from([`${formatConformanceSseEvent(first)}${formatConformanceSseEvent(changedEpoch)}`]);
  responseTwo.statusCode = 200;
  responseTwo.headers = { 'content-type': 'text/event-stream' };
  const secondClient = new ZipflowEventClient({ httpClient: { async openStream() { return responseTwo; } } });
  await assert.rejects(async () => {
    for await (const event of secondClient.events()) void event;
  }, /serverEpoch changed/);
});

test('event stream path rejects empty identifiers and stays within /v1/events', () => {
  assert.equal(buildEventStreamPath(), '/v1/events');
  assert.throws(() => buildEventStreamPath({ projectId: '' }), /projectId/);
  assert.throws(() => buildEventStreamPath({ operationId: 'bad\nvalue' }), /operationId/);
});
