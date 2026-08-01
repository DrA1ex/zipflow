import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { writeJsonDurableAtomic } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';
import { KeyedSerialQueue, readJsonStrict } from './store-utils.js';
import {
  ACTION_RECEIPT_SETTLEMENTS,
  cloneJson,
  createRunSessionRecord,
  RUN_SESSION_FILENAME,
  runSessionError,
  sameJson,
  terminalRunStatus,
  validateExecutionManifest,
  validateRunSessionRecord,
  validateStatus,
} from './run-session-model.js';

export const MAX_STORED_OUTPUT_RECORD_BYTES = 256 * 1024;

const RECEIPT_SETTLEMENTS = new Set(ACTION_RECEIPT_SETTLEMENTS);
const RUN_WRITE_QUEUE = new KeyedSerialQueue();
const ALLOWED_UPDATE_FIELDS = new Set([
  'status', 'operationId', 'executionManifest', 'publicSummary', 'completedAt',
]);

export class RunSessionStore {
  constructor({
    runsRoot = path.join(getZipflowHome(), 'runs'),
    now = () => new Date(),
  } = {}) {
    this.runsRoot = path.resolve(runsRoot);
    this.now = now;
    this.queue = RUN_WRITE_QUEUE;
    this.initialized = false;
  }

  async initialize() {
    const details = await lstat(this.runsRoot).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (details) assertSafeDirectory(details, this.runsRoot);
    this.initialized = true;
    return this;
  }

  async create(options) {
    validateRunId(options?.runId);
    return this.queue.run(this.sidecarPath(options.runId), async () => {
      await this.ensureInitialized();
      await this.assertRunDirectory(options.runId, { required: true });
      const existing = await this.read(options.runId);
      if (existing) throw runSessionError('Run session already exists.', 'RUN_SESSION_EXISTS', 409);
      const record = createRunSessionRecord(options, this.timestamp());
      await this.write(record);
      return cloneJson(record);
    });
  }

  async get(runId) {
    validateRunId(runId);
    await this.ensureInitialized();
    const directory = await this.assertRunDirectory(runId, { required: false });
    if (!directory) return null;
    return this.read(runId);
  }

  async list({ projectId = null, status = null } = {}) {
    await this.ensureInitialized();
    if (status !== null) validateStatus(status);
    const entries = await readdir(this.runsRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !validRunId(entry.name)) continue;
      const record = await this.read(entry.name);
      if (!record) continue;
      if (projectId !== null && record.binding.projectId !== projectId) continue;
      if (status !== null && record.run.status !== status) continue;
      records.push(record);
    }
    return records.sort((left, right) => (
      right.run.createdAt.localeCompare(left.run.createdAt)
      || left.run.runId.localeCompare(right.run.runId)
    ));
  }

  async loadWorkflowRecord(runId) {
    const record = await this.get(runId);
    return record ? workflowRecord(record) : null;
  }

  async compareAndSwapWorkflowRecord(runId, expectedRevision, nextRecord) {
    validateWorkflowReplacement(runId, expectedRevision, nextRecord);
    try {
      const persisted = await this.mutate(runId, expectedRevision, (record, timestamp) => {
        record.publicSummary = cloneJson(nextRecord.snapshot);
        record.executionManifest = validateExecutionManifest(nextRecord.privateState);
        record.actions = cloneJson(nextRecord.actions);
        const snapshotStatus = nextRecord.snapshot.run?.status;
        if (snapshotStatus !== undefined) {
          record.run.status = validateStatus(snapshotStatus);
          if (terminalRunStatus(snapshotStatus) && record.run.completedAt === null) {
            record.run.completedAt = timestamp;
          }
          if (!terminalRunStatus(snapshotStatus)) record.run.completedAt = null;
        }
        const operationId = nextRecord.snapshot.operation?.id
          ?? nextRecord.snapshot.operation?.operationId
          ?? null;
        record.run.operationId = operationId;
        return record;
      });
      if (persisted.revision !== nextRecord.revision) {
        throw runSessionError('Workflow replacement did not advance its revision.', 'WORKFLOW_RECORD_INVALID', 409);
      }
      return workflowRecord(persisted);
    } catch (error) {
      if (error?.code === 'STALE_REVISION') return false;
      throw error;
    }
  }

  workflowRepository() {
    return Object.freeze({
      load: (runId) => this.loadWorkflowRecord(runId),
      compareAndSwap: (runId, expectedRevision, nextRecord) => (
        this.compareAndSwapWorkflowRecord(runId, expectedRevision, nextRecord)
      ),
    });
  }

  async update({ runId, expectedRevision, changes = {} }) {
    if (!isPlainObject(changes)) throw new TypeError('Run session changes must be an object.');
    const unknown = Object.keys(changes).filter((key) => !ALLOWED_UPDATE_FIELDS.has(key));
    if (unknown.length) {
      const immutable = unknown.some((key) => ['binding', 'projectId', 'projectPath', 'workflowRevision', 'blobId', 'blobSha256'].includes(key));
      throw runSessionError(
        immutable ? 'Run binding is immutable.' : 'Run session change is not supported.',
        immutable ? 'IMMUTABLE_RUN_BINDING' : 'ACTION_INPUT_INVALID',
        409,
      );
    }
    return this.mutate(runId, expectedRevision, (record, timestamp) => {
      const next = cloneJson(record);
      if (changes.status !== undefined) {
        next.run.status = validateStatus(changes.status);
        if (changes.completedAt === undefined && terminalRunStatus(changes.status)) next.run.completedAt = timestamp;
      }
      if (changes.operationId !== undefined) next.run.operationId = changes.operationId;
      if (changes.executionManifest !== undefined) next.executionManifest = validateExecutionManifest(changes.executionManifest);
      if (changes.publicSummary !== undefined) next.publicSummary = cloneJson(changes.publicSummary);
      if (changes.completedAt !== undefined) next.run.completedAt = changes.completedAt;
      return next;
    });
  }

  async appendOutput({
    runId,
    expectedRevision,
    source,
    stream = 'event',
    text,
    commandId = null,
    checkId = null,
    truncated = false,
    omittedBytes = 0,
  }) {
    if (typeof text !== 'string') throw new TypeError('Output text must be a string.');
    if (!Number.isSafeInteger(omittedBytes) || omittedBytes < 0) throw new TypeError('Omitted output bytes are invalid.');
    return this.mutate(runId, expectedRevision, (record, timestamp) => {
      const limited = truncateUtf8(text, MAX_STORED_OUTPUT_RECORD_BYTES);
      record.outputs.push({
        sequence: (record.outputs.at(-1)?.sequence ?? 0) + 1,
        source,
        stream,
        text: limited.text,
        commandId,
        checkId,
        truncated: Boolean(truncated) || limited.truncated,
        omittedBytes: omittedBytes + limited.omittedBytes,
        createdAt: timestamp,
      });
      return record;
    });
  }

  async recordActionIntent({
    runId,
    expectedRevision,
    actionIntentId,
    actionId,
    idempotencyKey,
    requestFingerprint,
    surfaceRevision,
    input = {},
  }) {
    return this.mutate(runId, expectedRevision, (record, timestamp) => {
      const candidate = {
        actionIntentId, actionId, idempotencyKey, requestFingerprint, surfaceRevision,
        input: cloneJson(input), recordedAt: timestamp,
      };
      const existing = record.actions.find((item) => item.intent.actionIntentId === actionIntentId);
      if (existing) {
        if (sameIntent(existing.intent, candidate)) return record;
        throw runSessionError('Action intent ID was reused for different input.', 'ACTION_INTENT_CONFLICT', 409);
      }
      const reusedKey = record.actions.find((item) => item.intent.idempotencyKey === idempotencyKey);
      if (reusedKey) throw runSessionError('Action idempotency key is already bound.', 'ACTION_INTENT_CONFLICT', 409);
      record.actions.push({ intent: candidate, dispatch: null, receipt: null });
      return record;
    });
  }

  async markActionDispatched({ runId, expectedRevision, actionIntentId }) {
    return this.mutate(runId, expectedRevision, (record, timestamp) => {
      const action = requireAction(record, actionIntentId);
      if (action.receipt) throw runSessionError('Settled action cannot be dispatched.', 'ACTION_ALREADY_SETTLED', 409);
      if (action.dispatch) return record;
      action.dispatch = { attempt: 1, dispatchedAt: timestamp };
      return record;
    });
  }

  async recordActionReceipt(options) {
    return this.settleAction(options, { reconciliation: false });
  }

  async reconcileActionReceipt(options) {
    return this.settleAction(options, { reconciliation: true });
  }

  async listRecoveryActions(runId) {
    const record = await this.get(runId);
    if (!record) throw runSessionError('Run session was not found.', 'RUN_SESSION_NOT_FOUND', 404);
    return record.actions.flatMap((action) => {
      if (!action.dispatch && !action.receipt) return [{ ...cloneJson(action), recovery: 'dispatch_pending' }];
      if (action.dispatch && !action.receipt) return [{ ...cloneJson(action), recovery: 'reconcile_required' }];
      if (action.receipt?.settlement === 'uncertain') return [{ ...cloneJson(action), recovery: 'reconcile_required' }];
      return [];
    });
  }

  sidecarPath(runId) {
    validateRunId(runId);
    return path.join(this.runsRoot, runId, RUN_SESSION_FILENAME);
  }

  async settleAction({
    runId,
    expectedRevision,
    actionIntentId,
    settlement,
    response = null,
    error = null,
    evidence = null,
  }, { reconciliation }) {
    if (!RECEIPT_SETTLEMENTS.has(settlement)) throw new TypeError('Action receipt settlement is invalid.');
    const responseValue = cloneJson(response);
    const errorValue = sanitizeError(error);
    const evidenceValue = cloneJson(evidence);
    return this.mutate(runId, expectedRevision, (record, timestamp) => {
      const action = requireAction(record, actionIntentId);
      const current = action.receipt;
      const candidate = {
        settlement,
        response: responseValue,
        error: errorValue,
        evidence: reconciliation ? {
          previousSettlement: current?.settlement ?? (action.dispatch ? 'missing_after_dispatch' : 'not_dispatched'),
          detail: evidenceValue,
        } : evidenceValue,
        reconciled: reconciliation,
        recordedAt: timestamp,
      };
      if (!reconciliation) {
        if (current) {
          if (sameReceipt(current, candidate)) return record;
          throw runSessionError('Action receipt is already recorded.', 'ACTION_RECEIPT_ALREADY_RECORDED', 409);
        }
        if (['succeeded', 'failed'].includes(settlement) && !action.dispatch) {
          throw runSessionError('Action must be dispatched before it can settle.', 'ACTION_NOT_DISPATCHED', 409);
        }
      } else {
        const reconcilable = Boolean(action.dispatch && !current) || current?.settlement === 'uncertain';
        if (!reconcilable) {
          if (current && sameReceipt(current, candidate)) return record;
          throw runSessionError('Action does not require reconciliation.', 'ACTION_NOT_RECONCILABLE', 409);
        }
      }
      action.receipt = candidate;
      return record;
    });
  }

  async mutate(runId, expectedRevision, updater) {
    validateRunId(runId);
    return this.queue.run(this.sidecarPath(runId), async () => {
      await this.ensureInitialized();
      await this.assertRunDirectory(runId, { required: true });
      const current = await this.read(runId);
      if (!current) throw runSessionError('Run session was not found.', 'RUN_SESSION_NOT_FOUND', 404);
      assertRevision(current, expectedRevision);
      const timestamp = this.timestamp();
      const candidate = await updater(cloneJson(current), timestamp);
      if (!sameJson(candidate.binding, current.binding)) throw runSessionError('Run binding is immutable.', 'IMMUTABLE_RUN_BINDING', 409);
      if (sameJson(candidate, current)) return cloneJson(current);
      const next = {
        ...candidate,
        revision: current.revision + 1,
        run: { ...candidate.run, updatedAt: timestamp },
      };
      const validated = validateRunSessionRecord(next, { expectedRunId: runId, stored: false });
      await this.write(validated);
      return cloneJson(validated);
    });
  }

  async read(runId) {
    const target = this.sidecarPath(runId);
    const details = await lstat(target).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!details) return null;
    assertSafeFile(details, target);
    const value = await readJsonStrict(target, null);
    return validateRunSessionRecord(value, { expectedRunId: runId });
  }

  async write(record) {
    await writeJsonDurableAtomic(this.sidecarPath(record.run.runId), record);
  }

  async assertRunDirectory(runId, { required }) {
    const target = path.join(this.runsRoot, runId);
    const details = await lstat(target).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!details) {
      if (required) throw runSessionError('Existing run directory was not found.', 'RUN_DIRECTORY_NOT_FOUND', 404);
      return null;
    }
    assertSafeDirectory(details, target);
    return target;
  }

  async ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }

  timestamp() {
    const value = this.now();
    const timestamp = value instanceof Date ? value.toISOString() : String(value);
    if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError('Run session clock returned an invalid timestamp.');
    return timestamp;
  }
}

function requireAction(record, actionIntentId) {
  const action = record.actions.find((item) => item.intent.actionIntentId === actionIntentId);
  if (!action) throw runSessionError('Action intent was not found.', 'ACTION_INTENT_NOT_FOUND', 404);
  return action;
}

function workflowRecord(record) {
  return {
    runId: record.run.runId,
    kind: record.run.kind,
    revision: record.revision,
    snapshot: cloneJson(record.publicSummary),
    privateState: cloneJson(record.executionManifest),
    actions: cloneJson(record.actions),
  };
}

function validateWorkflowReplacement(runId, expectedRevision, value) {
  validateRunId(runId);
  if (
    !isPlainObject(value)
    || value.runId !== runId
    || !isPlainObject(value.snapshot)
    || !Array.isArray(value.actions)
    || !Object.hasOwn(value, 'privateState')
  ) {
    throw runSessionError('Workflow replacement record is invalid.', 'WORKFLOW_RECORD_INVALID', 400);
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || value.revision !== expectedRevision + 1) {
    throw runSessionError('Workflow replacement revision is invalid.', 'WORKFLOW_RECORD_INVALID', 409);
  }
  cloneJson(value.snapshot);
  validateExecutionManifest(value.privateState);
  cloneJson(value.actions);
}

function assertRevision(record, expected) {
  if (!Number.isSafeInteger(expected) || expected < 1 || expected !== record.revision) {
    throw runSessionError('Run session revision is stale.', 'STALE_REVISION', 409, {
      currentRevision: record.revision,
    });
  }
}

function sameIntent(left, right) {
  const { recordedAt: _leftTime, ...leftValue } = left;
  const { recordedAt: _rightTime, ...rightValue } = right;
  return sameJson(leftValue, rightValue);
}

function sameReceipt(left, right) {
  const { recordedAt: _leftTime, ...leftValue } = left;
  const { recordedAt: _rightTime, ...rightValue } = right;
  return sameJson(leftValue, rightValue);
}

function sanitizeError(value) {
  if (value == null) return null;
  if (value instanceof Error) return {
    name: value.name, message: value.message, code: value.code ?? null,
  };
  return cloneJson(value);
}

function truncateUtf8(value, maxBytes) {
  const source = Buffer.from(value);
  if (source.length <= maxBytes) return { text: value, truncated: false, omittedBytes: 0 };
  let end = maxBytes;
  let text = source.subarray(0, end).toString('utf8');
  while (text.endsWith('\uFFFD') && end > 0) text = source.subarray(0, --end).toString('utf8');
  return { text, truncated: true, omittedBytes: source.length - Buffer.byteLength(text) };
}

function assertSafeDirectory(details, target) {
  if (details.isSymbolicLink() || !details.isDirectory() || !ownedByCurrentUser(details)) {
    throw runSessionError('Run directory is unsafe.', 'SERVER_STORAGE_UNSAFE', 500, { path: target });
  }
}

function assertSafeFile(details, target) {
  if (details.isSymbolicLink() || !details.isFile() || !ownedByCurrentUser(details) || (details.mode & 0o077) !== 0) {
    throw runSessionError('Run session sidecar is unsafe.', 'SERVER_STORAGE_UNSAFE', 500, { path: target });
  }
}

function ownedByCurrentUser(details) {
  return typeof process.getuid !== 'function' || details.uid === process.getuid();
}

function validateRunId(value) {
  if (!validRunId(value)) throw runSessionError('Run ID is invalid.', 'INVALID_RUN_ID', 400);
}

function validRunId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
