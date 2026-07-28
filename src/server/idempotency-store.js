import path from 'node:path';
import { hashText } from '../utils/hash.js';
import { writeJsonDurableAtomic } from '../utils/fs.js';
import {
  ensurePrivateStorageRoot,
  KeyedSerialQueue,
  listJsonFiles,
  readJsonStrict,
  requestFingerprint,
} from './store-utils.js';

const TERMINAL_RECEIPT_STATUSES = new Set(['completed', 'failed', 'uncertain']);

export class IdempotencyStore {
  constructor({
    root,
    now = () => new Date(),
  } = {}) {
    if (!root) throw new TypeError('Idempotency store root is required.');
    this.root = path.resolve(root);
    this.now = now;
    this.queue = new KeyedSerialQueue();
    this.initialized = false;
  }

  async initialize() {
    await ensurePrivateStorageRoot(this.root);
    this.initialized = true;
    return this;
  }

  async claim({
    key,
    fingerprint,
    operationId = null,
    metadata = null,
  }) {
    validateKey(key);
    validateFingerprint(fingerprint);
    const keyHash = hashText(key);
    return this.queue.run(keyHash, async () => {
      await this.ensureInitialized();
      const existing = await this.readByHash(keyHash);
      if (existing) return claimFromExisting(existing, fingerprint);

      const timestamp = this.now().toISOString();
      const record = {
        version: 1,
        keyHash,
        fingerprint,
        status: 'active',
        operationId,
        metadata,
        receipt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        settledAt: null,
      };
      await this.write(record);
      return { kind: 'claimed', record: clone(record) };
    });
  }

  async complete({ key, fingerprint, receipt }) {
    return this.settle({ key, fingerprint, status: 'completed', receipt });
  }

  async fail({ key, fingerprint, receipt }) {
    return this.settle({ key, fingerprint, status: 'failed', receipt });
  }

  async markUncertain({ key, fingerprint, receipt = null }) {
    return this.settle({ key, fingerprint, status: 'uncertain', receipt });
  }

  async settle({ key, fingerprint, status, receipt }) {
    validateKey(key);
    validateFingerprint(fingerprint);
    if (!TERMINAL_RECEIPT_STATUSES.has(status)) throw new TypeError(`Invalid receipt status: ${status}`);
    const keyHash = hashText(key);
    return this.queue.run(keyHash, async () => {
      await this.ensureInitialized();
      const existing = await this.readByHash(keyHash);
      if (!existing) throw receiptError('Idempotency claim does not exist.', 'IDEMPOTENCY_CLAIM_MISSING', 409);
      assertFingerprint(existing, fingerprint);
      if (existing.status !== 'active') {
        if (existing.status === status && sameReceipt(existing.receipt, receipt)) return clone(existing);
        throw receiptError('Idempotency receipt is already settled.', 'IDEMPOTENCY_ALREADY_SETTLED', 409);
      }
      const timestamp = this.now().toISOString();
      const record = {
        ...existing,
        status,
        receipt,
        updatedAt: timestamp,
        settledAt: timestamp,
      };
      await this.write(record);
      return clone(record);
    });
  }

  async get(key) {
    validateKey(key);
    await this.ensureInitialized();
    const value = await this.readByHash(hashText(key));
    return value ? clone(value) : null;
  }

  async reconcileActive(reconciler = async () => ({ status: 'uncertain', receipt: null })) {
    await this.ensureInitialized();
    const names = await listJsonFiles(this.root);
    const changed = [];
    for (const name of names) {
      const keyHash = name.slice(0, -5);
      await this.queue.run(keyHash, async () => {
        const current = await this.readByHash(keyHash);
        if (!current || current.status !== 'active') return;
        const resolution = await reconciler(clone(current));
        const status = resolution?.status ?? 'uncertain';
        if (!TERMINAL_RECEIPT_STATUSES.has(status)) {
          throw new TypeError(`Invalid reconciled receipt status: ${status}`);
        }
        const timestamp = this.now().toISOString();
        const settled = {
          ...current,
          status,
          receipt: resolution?.receipt ?? null,
          updatedAt: timestamp,
          settledAt: timestamp,
        };
        await this.write(settled);
        changed.push(clone(settled));
      });
    }
    return changed;
  }

  async readByHash(keyHash) {
    const value = await readJsonStrict(this.pathForHash(keyHash), null);
    if (!value) return null;
    return validateRecord(value, keyHash);
  }

  async write(record) {
    await writeJsonDurableAtomic(this.pathForHash(record.keyHash), record);
  }

  pathForHash(keyHash) {
    return path.join(this.root, `${keyHash}.json`);
  }

  async ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }
}

export function fingerprintRequest(value) {
  return requestFingerprint(value);
}

function claimFromExisting(existing, fingerprint) {
  assertFingerprint(existing, fingerprint);
  if (existing.status === 'active') return { kind: 'in-progress', record: clone(existing) };
  return { kind: 'replay', receipt: clone(existing.receipt), record: clone(existing) };
}

function assertFingerprint(record, fingerprint) {
  if (record.fingerprint === fingerprint) return;
  throw receiptError(
    'Idempotency-Key was already used for a different request.',
    'IDEMPOTENCY_CONFLICT',
    409,
  );
}

function validateRecord(value, keyHash) {
  if (
    value?.version !== 1
    || value.keyHash !== keyHash
    || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !['active', ...TERMINAL_RECEIPT_STATUSES].includes(value.status)
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw Object.assign(new Error('Idempotency receipt is corrupt.'), { code: 'SERVER_STORAGE_CORRUPT' });
  }
  return value;
}

function validateKey(key) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(key)) {
    throw receiptError('Idempotency key is invalid.', 'INVALID_IDEMPOTENCY_KEY', 400);
  }
}

function validateFingerprint(value) {
  if (!/^[a-f0-9]{64}$/.test(String(value ?? ''))) {
    throw new TypeError('Idempotency fingerprint must be a SHA-256 hex digest.');
  }
}

function sameReceipt(left, right) {
  return requestFingerprint(left) === requestFingerprint(right);
}

function receiptError(message, code, status) {
  return Object.assign(new Error(message), { code, status, expose: true, detail: message });
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}
