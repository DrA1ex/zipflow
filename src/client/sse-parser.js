import { StringDecoder } from 'node:string_decoder';
import { assertProtocolValue } from '../protocol/validation.js';

export class SseProtocolError extends TypeError {
  constructor(message, { cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SseProtocolError';
    this.code = 'INVALID_SSE_EVENT';
  }
}

export class SseParser {
  constructor() {
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.dataLines = [];
    this.eventType = '';
    this.lastEventId = '';
    this.retry = null;
    this.started = false;
    this.finished = false;
  }

  push(chunk) {
    if (this.finished) throw new TypeError('Cannot push data after the SSE parser has finished.');
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      throw new TypeError('SSE chunks must be strings, Buffers, or Uint8Arrays.');
    }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.buffer += this.decoder.write(bytes);
    return this.drain(false);
  }

  finish() {
    if (this.finished) return [];
    this.finished = true;
    this.buffer += this.decoder.end();
    const records = this.drain(true);
    const trailing = this.dispatch();
    if (trailing) records.push(trailing);
    return records;
  }

  drain(final) {
    const records = [];
    while (true) {
      const boundary = findLineBoundary(this.buffer, final);
      if (!boundary) break;
      const line = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const record = this.processLine(line);
      if (record) records.push(record);
    }
    if (final && this.buffer) {
      const record = this.processLine(this.buffer);
      this.buffer = '';
      if (record) records.push(record);
    }
    return records;
  }

  processLine(rawLine) {
    let line = rawLine;
    if (!this.started) {
      this.started = true;
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    }
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventType = value;
    else if (field === 'id' && !value.includes('\0')) this.lastEventId = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
    return null;
  }

  dispatch() {
    const hasData = this.dataLines.length > 0;
    const record = hasData ? {
      id: this.lastEventId || null,
      event: this.eventType || 'message',
      data: this.dataLines.join('\n'),
      retry: this.retry,
    } : null;
    this.dataLines = [];
    this.eventType = '';
    return record;
  }
}

export function parseSse(input) {
  const chunks = Array.isArray(input) ? input : [input];
  const parser = new SseParser();
  const records = chunks.flatMap((chunk) => parser.push(chunk));
  return records.concat(parser.finish());
}

export function parseZipflowSseRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.data !== 'string') {
    throw new SseProtocolError('SSE record is missing event data.');
  }
  let payload;
  try { payload = JSON.parse(record.data); } catch (cause) {
    throw new SseProtocolError('Zipflow SSE data is not valid JSON.', { cause });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SseProtocolError('Zipflow SSE data must be a JSON object.');
  }
  const event = { ...payload, type: record.event };
  try { assertProtocolValue('event', event); } catch (cause) {
    throw new SseProtocolError(`Zipflow SSE event ${record.event || 'message'} does not match protocol v1.`, { cause });
  }
  if (record.id === null || !/^\d+$/.test(record.id) || String(event.sequence) !== record.id) {
    throw new SseProtocolError('Zipflow SSE id must equal the JSON sequence.');
  }
  if (event.type === 'stream.gap' && !Number.isInteger(event.data.retainedFrom)) {
    throw new SseProtocolError('stream.gap must include an integer retainedFrom cursor.');
  }
  return { ...event, id: record.id, retry: record.retry };
}

function findLineBoundary(value, final) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\n') return { index, length: 1 };
    if (value[index] !== '\r') continue;
    if (index + 1 === value.length && !final) return null;
    return { index, length: value[index + 1] === '\n' ? 2 : 1 };
  }
  return null;
}
