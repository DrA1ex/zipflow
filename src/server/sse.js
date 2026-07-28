export class SseHub {
  constructor({
    journal,
    heartbeatMs = 15_000,
    maxBufferedEvents = 256,
  } = {}) {
    if (!journal) throw new TypeError('SSE hub requires an event journal.');
    this.journal = journal;
    this.heartbeatMs = heartbeatMs;
    this.maxBufferedEvents = maxBufferedEvents;
    this.connections = new Set();
    this.stopping = false;
  }

  async open({ request, response, query }) {
    if (this.stopping) {
      throw Object.assign(new Error('The server is stopping.'), {
        code: 'SERVER_STOPPING',
        status: 503,
        expose: true,
        detail: 'The server is stopping.',
      });
    }
    const filters = parseEventFilters(query);
    const cursor = readEventCursor(request.headers['last-event-id']);
    await this.journal.ensureInitialized();
    return new Promise((resolve) => {
      const connection = createSseConnection({
        request,
        response,
        journal: this.journal,
        filters,
        cursor,
        heartbeatMs: this.heartbeatMs,
        maxBufferedEvents: this.maxBufferedEvents,
        onClose: () => {
          this.connections.delete(connection);
          resolve();
        },
      });
      this.connections.add(connection);
      connection.start();
    });
  }

  closeAll() {
    this.stopping = true;
    for (const connection of [...this.connections]) connection.close();
  }
}

export function formatSseEvent(event) {
  const type = String(event.type ?? '').replace(/[\r\n]/g, '');
  const id = String(event.sequence ?? '').replace(/[\r\n]/g, '');
  const data = JSON.stringify({
    serverEpoch: event.serverEpoch,
    sequence: event.sequence,
    projectId: event.projectId ?? null,
    runId: event.runId ?? null,
    operationId: event.operationId ?? null,
    revision: event.revision ?? null,
    data: event.data ?? {},
  });
  return `id: ${id}\nevent: ${type}\ndata: ${data}\n\n`;
}

export function parseEventFilters(query) {
  const filters = {};
  for (const key of ['projectId', 'runId', 'operationId']) {
    const values = query?.getAll?.(key) ?? [];
    if (values.length > 1) throw sseError(`${key} may be provided only once.`);
    if (!values.length) continue;
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(values[0])) throw sseError(`${key} is invalid.`);
    filters[key] = values[0];
  }
  return filters;
}

function createSseConnection({
  request,
  response,
  journal,
  filters,
  cursor,
  heartbeatMs,
  maxBufferedEvents,
  onClose,
}) {
  let closed = false;
  let unsubscribe = null;
  let heartbeat = null;
  let waitingDrain = false;
  const buffered = [];
  let lastWritten = cursor;

  function start() {
    response.writeHead(200, {
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders?.();

    const replay = journal.replay({ after: cursor, filters });
    if (replay.gap) {
      const sequence = Math.max(cursor + 1, replay.latest + 1);
      response.end(formatSseEvent({
        type: 'stream.gap',
        serverEpoch: journal.serverEpoch,
        sequence,
        data: {
          requestedAfter: cursor,
          retainedFrom: replay.retainedFrom,
          latest: replay.latest,
        },
      }));
      finish();
      return;
    }

    unsubscribe = journal.subscribe(queueEvent, { filters });
    for (const event of replay.events) queueEvent(event);
    heartbeat = setInterval(() => {
      if (!closed && !waitingDrain) response.write(': keep-alive\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();
    request.once('aborted', finish);
    request.once('close', finish);
    response.once('close', finish);
    response.once('error', finish);
  }

  function queueEvent(event) {
    if (closed || event.sequence <= lastWritten) return;
    if (!waitingDrain && buffered.length === 0) {
      writeEvent(event);
      return;
    }
    buffered.push(event);
    if (buffered.length > maxBufferedEvents) close();
  }

  function writeEvent(event) {
    if (closed) return;
    lastWritten = event.sequence;
    if (response.write(formatSseEvent(event))) return;
    waitingDrain = true;
    response.once('drain', flush);
  }

  function flush() {
    if (closed) return;
    waitingDrain = false;
    while (buffered.length && !waitingDrain) writeEvent(buffered.shift());
  }

  function close() {
    if (closed) return;
    response.end();
    finish();
  }

  function finish() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
    request.off('aborted', finish);
    request.off('close', finish);
    response.off('close', finish);
    response.off('error', finish);
    onClose();
  }

  return { start, close };
}

function readEventCursor(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw sseError('Last-Event-ID is invalid.');
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw sseError('Last-Event-ID is invalid.');
  return cursor;
}

function sseError(detail) {
  return Object.assign(new Error(detail), {
    code: 'INVALID_EVENT_CURSOR',
    status: 400,
    expose: true,
    detail,
  });
}
