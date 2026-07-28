import path from 'node:path';
import { EventEmitter } from 'node:events';
import { hashText } from '../utils/hash.js';
import { writeJsonDurableAtomic } from '../utils/fs.js';
import {
  ensurePrivateStorageRoot,
  KeyedSerialQueue,
  readJsonStrict,
} from './store-utils.js';

export const DEFAULT_EVENT_RETENTION = 10_000;

export class EventJournal {
  constructor({
    root,
    serverEpoch,
    maxEvents = DEFAULT_EVENT_RETENTION,
    now = () => new Date(),
  } = {}) {
    if (!root) throw new TypeError('Event journal root is required.');
    if (!serverEpoch || typeof serverEpoch !== 'string') throw new TypeError('Server epoch is required.');
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new TypeError('Event retention must be a positive integer.');
    this.root = path.resolve(root);
    this.serverEpoch = serverEpoch;
    this.maxEvents = maxEvents;
    this.now = now;
    this.journalPath = path.join(this.root, `epoch-${hashText(serverEpoch).slice(0, 32)}.json`);
    this.queue = new KeyedSerialQueue();
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
    this.state = null;
    this.coalesced = new Map();
  }

  async initialize() {
    await ensurePrivateStorageRoot(this.root);
    const stored = await readJsonStrict(this.journalPath, null);
    this.state = stored ? validateJournal(stored, this.serverEpoch) : emptyJournal(this.serverEpoch);
    return this;
  }

  async append(type, fields = {}) {
    validateEventType(type);
    return this.queue.run('journal', async () => {
      await this.ensureInitialized();
      const sequence = this.state.nextSequence;
      const event = normalizeEvent({
        serverEpoch: this.serverEpoch,
        sequence,
        type,
        createdAt: this.now().toISOString(),
        ...fields,
      });
      const events = [...this.state.events, event];
      if (events.length > this.maxEvents) events.splice(0, events.length - this.maxEvents);
      this.state = {
        ...this.state,
        nextSequence: sequence + 1,
        retainedFrom: events[0]?.sequence ?? sequence + 1,
        events,
      };
      await writeJsonDurableAtomic(this.journalPath, this.state);
      this.emitter.emit('event', clone(event));
      return clone(event);
    });
  }

  appendCoalesced(type, fields = {}, {
    key = defaultCoalesceKey(type, fields),
    delayMs = 25,
  } = {}) {
    validateEventType(type);
    const existing = this.coalesced.get(key);
    if (existing) {
      existing.type = type;
      existing.fields = fields;
      return existing.promise;
    }
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const pending = {
      type,
      fields,
      promise,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.coalesced.delete(key);
        this.append(pending.type, pending.fields).then(resolve, reject);
      }, Math.max(0, delayMs)),
    };
    pending.timer.unref?.();
    this.coalesced.set(key, pending);
    return promise;
  }

  async flushCoalesced() {
    const pending = [...this.coalesced.entries()];
    for (const [key, item] of pending) {
      clearTimeout(item.timer);
      this.coalesced.delete(key);
      this.append(item.type, item.fields).then(item.resolve, item.reject);
    }
    await Promise.all(pending.map(([, item]) => item.promise));
  }

  replay({ after = 0, filters = null } = {}) {
    if (!this.state) throw new Error('Event journal is not initialized.');
    const cursor = normalizeCursor(after);
    const latest = this.state.nextSequence - 1;
    const retainedFrom = this.state.retainedFrom;
    const gap = cursor > latest || (cursor !== 0 && cursor < retainedFrom - 1)
      || (cursor === 0 && retainedFrom > 1);
    if (gap) return { gap: true, retainedFrom, latest, events: [] };
    return {
      gap: false,
      retainedFrom,
      latest,
      events: this.state.events
        .filter((event) => event.sequence > cursor && eventMatchesFilters(event, filters))
        .map(clone),
    };
  }

  subscribe(listener, { filters = null } = {}) {
    if (typeof listener !== 'function') throw new TypeError('Event listener is required.');
    const wrapped = (event) => {
      if (eventMatchesFilters(event, filters)) listener(clone(event));
    };
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  latestSequence() {
    if (!this.state) throw new Error('Event journal is not initialized.');
    return this.state.nextSequence - 1;
  }

  async ensureInitialized() {
    if (!this.state) await this.initialize();
  }
}

export function eventMatchesFilters(event, filters) {
  if (!filters) return true;
  for (const key of ['projectId', 'runId', 'operationId']) {
    if (filters[key] != null && event[key] !== filters[key]) return false;
  }
  return true;
}

function emptyJournal(serverEpoch) {
  return {
    version: 1,
    serverEpoch,
    nextSequence: 1,
    retainedFrom: 1,
    events: [],
  };
}

function validateJournal(value, serverEpoch) {
  if (
    value?.version !== 1
    || value.serverEpoch !== serverEpoch
    || !Number.isSafeInteger(value.nextSequence)
    || value.nextSequence < 1
    || !Number.isSafeInteger(value.retainedFrom)
    || !Array.isArray(value.events)
  ) {
    throw corruptJournal();
  }
  let previous = 0;
  for (const event of value.events) {
    validateStoredEvent(event, serverEpoch);
    if (event.sequence <= previous) throw corruptJournal();
    previous = event.sequence;
  }
  if (previous >= value.nextSequence) throw corruptJournal();
  if (value.events.length && value.retainedFrom !== value.events[0].sequence) throw corruptJournal();
  return clone(value);
}

function normalizeEvent(value) {
  const event = {
    serverEpoch: value.serverEpoch,
    sequence: value.sequence,
    type: value.type,
    createdAt: value.createdAt,
    projectId: nullableId(value.projectId),
    runId: nullableId(value.runId),
    operationId: nullableId(value.operationId),
    revision: Number.isInteger(value.revision) ? value.revision : null,
    data: value.data && typeof value.data === 'object' ? clone(value.data) : {},
  };
  validateStoredEvent(event, value.serverEpoch);
  return event;
}

function validateStoredEvent(event, serverEpoch) {
  validateEventType(event?.type);
  if (
    event.serverEpoch !== serverEpoch
    || !Number.isSafeInteger(event.sequence)
    || event.sequence < 1
    || !Number.isFinite(Date.parse(event.createdAt))
    || !event.data
    || typeof event.data !== 'object'
    || Array.isArray(event.data)
  ) {
    throw corruptJournal();
  }
}

function validateEventType(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(value)) {
    throw new TypeError(`Invalid event type: ${value}`);
  }
}

function normalizeCursor(value) {
  const cursor = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw Object.assign(new Error('Event cursor is invalid.'), {
      code: 'INVALID_EVENT_CURSOR',
      status: 400,
      expose: true,
      detail: 'Event cursor is invalid.',
    });
  }
  return cursor;
}

function nullableId(value) {
  return typeof value === 'string' && value ? value : null;
}

function defaultCoalesceKey(type, fields) {
  return [type, fields.projectId, fields.runId, fields.operationId].filter(Boolean).join(':');
}

function corruptJournal() {
  return Object.assign(new Error('Event journal is corrupt.'), { code: 'SERVER_STORAGE_CORRUPT' });
}

function clone(value) {
  return structuredClone(value);
}
