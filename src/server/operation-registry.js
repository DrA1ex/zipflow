import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonDurableAtomic } from '../utils/fs.js';
import {
  ensurePrivateStorageRoot,
  KeyedSerialQueue,
  listJsonFiles,
  readJsonStrict,
} from './store-utils.js';

export const ACTIVE_OPERATION_SETTLEMENTS = new Set([
  'active',
  'cancel_requested',
  'cancel_deferred',
]);

export const TERMINAL_OPERATION_SETTLEMENTS = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'uncertain',
]);

export class OperationRegistry {
  constructor({
    root,
    journal = null,
    now = () => new Date(),
    createId = () => `operation_${randomUUID()}`,
  } = {}) {
    if (!root) throw new TypeError('Operation registry root is required.');
    this.root = path.resolve(root);
    this.journal = journal;
    this.now = now;
    this.createId = createId;
    this.queue = new KeyedSerialQueue();
    this.records = new Map();
    this.activeByProject = new Map();
    this.controllers = new Map();
    this.initialized = false;
  }

  async initialize({
    reconcile = async () => ({ settlement: 'uncertain' }),
  } = {}) {
    if (this.initialized) return this;
    await ensurePrivateStorageRoot(this.root);
    for (const name of await listJsonFiles(this.root)) {
      const operationId = name.slice(0, -5);
      const stored = validateOperation(await readJsonStrict(path.join(this.root, name)), operationId);
      this.records.set(operationId, stored);
    }
    for (const record of [...this.records.values()]) {
      if (!ACTIVE_OPERATION_SETTLEMENTS.has(record.settlement)) continue;
      const resolution = await reconcile(clone(record));
      const settlement = resolution?.settlement ?? 'uncertain';
      if (!TERMINAL_OPERATION_SETTLEMENTS.has(settlement)) {
        throw new TypeError(`Invalid reconciled operation settlement: ${settlement}`);
      }
      const settled = this.settledRecord(record, settlement, resolution?.error);
      await this.persist(settled);
      this.records.set(record.operationId, settled);
      await this.emit('operation.settled', settled);
    }
    this.rebuildActiveProjects();
    this.initialized = true;
    return this;
  }

  async begin({
    projectId,
    runId = null,
    kind,
    cancellable = true,
    metadata = null,
  }) {
    validateId(projectId, 'project ID');
    validateKind(kind);
    await this.ensureInitialized();
    return this.queue.run(projectId, async () => {
      const activeId = this.activeByProject.get(projectId);
      if (activeId) {
        throw operationError('The project already has an active mutation.', 'PROJECT_OPERATION_BUSY', 409, {
          operationId: activeId,
        });
      }
      const timestamp = this.now().toISOString();
      const operationId = this.createId();
      validateId(operationId, 'operation ID');
      const record = {
        version: 1,
        operationId,
        projectId,
        runId,
        kind,
        settlement: 'active',
        phase: null,
        critical: false,
        cancellable: Boolean(cancellable),
        cancelRequested: false,
        revision: 1,
        metadata: metadata == null ? null : clone(metadata),
        error: null,
        startedAt: timestamp,
        updatedAt: timestamp,
        settledAt: null,
      };
      const controller = new AbortController();
      await this.persist(record);
      this.records.set(operationId, record);
      this.activeByProject.set(projectId, operationId);
      this.controllers.set(operationId, controller);
      await this.emit('operation.started', record);
      return createHandle(this, operationId, controller);
    });
  }

  async run(options, callback) {
    if (typeof callback !== 'function') throw new TypeError('Operation callback is required.');
    const handle = await this.begin(options);
    try {
      const result = await callback(handle);
      await handle.settle(handle.signal.aborted ? 'cancelled' : 'succeeded');
      return result;
    } catch (error) {
      await handle.settle(
        handle.signal.aborted || error?.code === 'cancelled' ? 'cancelled' : 'failed',
        { error },
      );
      throw error;
    }
  }

  async get(operationId) {
    await this.ensureInitialized();
    const record = this.records.get(operationId);
    return record ? clone(record) : null;
  }

  async list({ projectId = null, activeOnly = false } = {}) {
    await this.ensureInitialized();
    return [...this.records.values()]
      .filter((record) => !projectId || record.projectId === projectId)
      .filter((record) => !activeOnly || ACTIVE_OPERATION_SETTLEMENTS.has(record.settlement))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map(clone);
  }

  async update(operationId, changes = {}) {
    return this.mutate(operationId, async (record) => {
      if (!ACTIVE_OPERATION_SETTLEMENTS.has(record.settlement)) return record;
      return this.changedRecord(record, {
        phase: changes.phase === undefined ? record.phase : cleanPhase(changes.phase),
        metadata: changes.metadata === undefined ? record.metadata : clone(changes.metadata),
      });
    }, { progress: changes.progress });
  }

  async enterCritical(operationId, phase = undefined) {
    return this.mutate(operationId, async (record) => {
      if (!ACTIVE_OPERATION_SETTLEMENTS.has(record.settlement)) return record;
      return this.changedRecord(record, {
        critical: true,
        phase: phase === undefined ? record.phase : cleanPhase(phase),
      });
    });
  }

  async leaveCritical(operationId, phase = undefined) {
    let abort = false;
    const record = await this.mutate(operationId, async (current) => {
      if (!ACTIVE_OPERATION_SETTLEMENTS.has(current.settlement)) return current;
      abort = current.cancelRequested && current.cancellable;
      return this.changedRecord(current, {
        critical: false,
        phase: phase === undefined ? current.phase : cleanPhase(phase),
        settlement: abort ? 'cancel_requested' : current.settlement,
      });
    });
    if (abort) this.controllers.get(operationId)?.abort('cancelled');
    return record;
  }

  async requestCancellation(operationId) {
    let shouldAbort = false;
    const operation = await this.mutate(operationId, async (record) => {
      if (TERMINAL_OPERATION_SETTLEMENTS.has(record.settlement)) return record;
      const deferred = record.critical || !record.cancellable;
      shouldAbort = !deferred;
      return this.changedRecord(record, {
        cancelRequested: true,
        settlement: deferred ? 'cancel_deferred' : 'cancel_requested',
      });
    }, { eventType: 'operation.cancel_requested' });
    if (shouldAbort) this.controllers.get(operationId)?.abort('cancelled');
    return {
      status: TERMINAL_OPERATION_SETTLEMENTS.has(operation.settlement) ? 200 : 202,
      operation,
    };
  }

  async settle(operationId, settlement, { error = null } = {}) {
    if (!TERMINAL_OPERATION_SETTLEMENTS.has(settlement)) {
      throw new TypeError(`Invalid operation settlement: ${settlement}`);
    }
    const record = await this.mutate(operationId, async (current) => {
      if (TERMINAL_OPERATION_SETTLEMENTS.has(current.settlement)) {
        if (current.settlement === settlement) return current;
        throw operationError('Operation is already settled.', 'OPERATION_ALREADY_SETTLED', 409);
      }
      return this.settledRecord(current, settlement, error);
    }, { eventType: 'operation.settled' });
    return record;
  }

  async mutate(operationId, updater, { eventType = null, progress = null } = {}) {
    await this.ensureInitialized();
    const current = this.records.get(operationId);
    if (!current) throw operationError('Operation was not found.', 'OPERATION_NOT_FOUND', 404);
    return this.queue.run(current.projectId, async () => {
      const before = this.records.get(operationId);
      const next = await updater(clone(before));
      if (sameRecord(before, next)) return clone(before);
      await this.persist(next);
      this.records.set(operationId, next);
      if (TERMINAL_OPERATION_SETTLEMENTS.has(next.settlement)) {
        this.activeByProject.delete(next.projectId);
        this.controllers.delete(operationId);
      }
      if (eventType) await this.emit(eventType, next);
      else if (progress !== undefined) {
        await this.emit('operation.progress', next, progress, { coalesced: true });
      }
      return clone(next);
    });
  }

  changedRecord(record, changes) {
    return {
      ...record,
      ...changes,
      revision: record.revision + 1,
      updatedAt: this.now().toISOString(),
    };
  }

  settledRecord(record, settlement, error = null) {
    const timestamp = this.now().toISOString();
    return {
      ...record,
      settlement,
      critical: false,
      error: settlement === 'failed' || settlement === 'uncertain' ? sanitizeError(error) : null,
      revision: record.revision + 1,
      updatedAt: timestamp,
      settledAt: timestamp,
    };
  }

  async emit(type, record, data = null, { coalesced = false } = {}) {
    if (!this.journal) return;
    const fields = {
      projectId: record.projectId,
      runId: record.runId,
      operationId: record.operationId,
      revision: record.revision,
      data: data && typeof data === 'object' ? data : {
        kind: record.kind,
        settlement: record.settlement,
        phase: record.phase,
      },
    };
    if (coalesced) await this.journal.appendCoalesced(type, fields);
    else await this.journal.append(type, fields);
  }

  async persist(record) {
    await writeJsonDurableAtomic(path.join(this.root, `${record.operationId}.json`), record);
  }

  rebuildActiveProjects() {
    this.activeByProject.clear();
    for (const record of this.records.values()) {
      if (!ACTIVE_OPERATION_SETTLEMENTS.has(record.settlement)) continue;
      if (this.activeByProject.has(record.projectId)) {
        throw Object.assign(new Error('Multiple durable operations own one project.'), { code: 'SERVER_STORAGE_CORRUPT' });
      }
      this.activeByProject.set(record.projectId, record.operationId);
    }
  }

  async ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }
}

function createHandle(registry, operationId, controller) {
  return Object.freeze({
    operationId,
    signal: controller.signal,
    snapshot: () => registry.get(operationId),
    update: (changes) => registry.update(operationId, changes),
    enterCritical: (phase) => registry.enterCritical(operationId, phase),
    leaveCritical: (phase) => registry.leaveCritical(operationId, phase),
    requestCancellation: () => registry.requestCancellation(operationId),
    settle: (settlement, options) => registry.settle(operationId, settlement, options),
  });
}

function validateOperation(record, operationId) {
  if (
    record?.version !== 1
    || record.operationId !== operationId
    || typeof record.projectId !== 'string'
    || typeof record.kind !== 'string'
    || ![...ACTIVE_OPERATION_SETTLEMENTS, ...TERMINAL_OPERATION_SETTLEMENTS].includes(record.settlement)
    || !Number.isInteger(record.revision)
    || !Number.isFinite(Date.parse(record.startedAt))
    || !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    throw Object.assign(new Error('Operation record is corrupt.'), { code: 'SERVER_STORAGE_CORRUPT' });
  }
  return clone(record);
}

function validateId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new TypeError(`Invalid ${name}.`);
  }
}

function validateKind(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new TypeError('Invalid operation kind.');
  }
}

function cleanPhase(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(value)) {
    throw new TypeError('Invalid operation phase.');
  }
  return value;
}

function sanitizeError(error) {
  if (!error) return null;
  const code = typeof error.code === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(error.code)
    ? error.code
    : 'OPERATION_FAILED';
  return { code, message: 'The operation did not settle successfully.' };
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function operationError(message, code, status, details = {}) {
  return Object.assign(new Error(message), {
    code,
    status,
    expose: true,
    detail: message,
    ...details,
  });
}

function clone(value) {
  return structuredClone(value);
}
