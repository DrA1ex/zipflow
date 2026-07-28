import { PROTOCOL_MEDIA_TYPES, PROTOCOL_PATHS } from '../protocol/constants.js';
import { LocalEndpointHttpClient, ZipflowTransportError } from './http-client.js';
import { parseZipflowSseRecord, SseParser, SseProtocolError } from './sse-parser.js';

export class ZipflowEventClient {
  constructor({ httpClient = undefined, ...httpOptions } = {}) {
    this.http = httpClient ?? new LocalEndpointHttpClient(httpOptions);
  }

  events(options = {}) {
    return this.subscribe(options);
  }

  async *subscribe({
    projectId = undefined,
    runId = undefined,
    operationId = undefined,
    lastEventId = undefined,
    serverEpoch = undefined,
    signal = undefined,
  } = {}) {
    const cursor = normalizeCursor(lastEventId);
    const path = buildEventStreamPath({ projectId, runId, operationId });
    const headers = { accept: PROTOCOL_MEDIA_TYPES.events };
    if (cursor !== null) headers['last-event-id'] = String(cursor);
    const response = await this.http.openStream(path, { headers, signal });
    const mediaType = String(response.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== PROTOCOL_MEDIA_TYPES.events) {
      response.destroy();
      throw new ZipflowTransportError('INVALID_EVENT_STREAM', 'Zipflow returned a non-SSE event response.', {
        statusCode: response.statusCode,
      });
    }

    const parser = new SseParser();
    let previousSequence = cursor;
    let observedEpoch = serverEpoch ?? null;
    try {
      for await (const chunk of response) {
        for (const record of parser.push(chunk)) {
          const event = parseZipflowSseRecord(record);
          ({ previousSequence, observedEpoch } = verifyOrder(event, previousSequence, observedEpoch));
          yield event;
          if (event.type === 'stream.gap') return;
        }
      }
      for (const record of parser.finish()) {
        const event = parseZipflowSseRecord(record);
        ({ previousSequence, observedEpoch } = verifyOrder(event, previousSequence, observedEpoch));
        yield event;
        if (event.type === 'stream.gap') return;
      }
    } finally {
      if (!response.destroyed) response.destroy();
    }
  }
}

export function createZipflowEventClient(options) {
  return new ZipflowEventClient(options);
}

export function buildEventStreamPath({ projectId, runId, operationId } = {}) {
  const parameters = new URLSearchParams();
  addFilter(parameters, 'projectId', projectId);
  addFilter(parameters, 'runId', runId);
  addFilter(parameters, 'operationId', operationId);
  const query = parameters.toString();
  return query ? `${PROTOCOL_PATHS.events}?${query}` : PROTOCOL_PATHS.events;
}

function verifyOrder(event, previousSequence, observedEpoch) {
  if (previousSequence !== null && event.sequence <= previousSequence) {
    throw new SseProtocolError(`Zipflow SSE sequence ${event.sequence} does not advance cursor ${previousSequence}.`);
  }
  if (observedEpoch !== null && event.serverEpoch !== observedEpoch) {
    throw new SseProtocolError('Zipflow SSE serverEpoch changed within one stream.');
  }
  return { previousSequence: event.sequence, observedEpoch: observedEpoch ?? event.serverEpoch };
}

function normalizeCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || String(numeric) !== String(value)) {
    throw new TypeError('lastEventId must be a non-negative integer cursor.');
  }
  return numeric;
}

function addFilter(parameters, name, value) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) {
    throw new TypeError(`${name} must be a non-empty identifier.`);
  }
  parameters.set(name, value);
}
