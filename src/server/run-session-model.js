import path from 'node:path';
import { stableJson } from './store-utils.js';

export const RUN_SESSION_FILENAME = 'server-session-v1.json';
export const RUN_SESSION_VERSION = 1;
export const RUN_SESSION_STATUSES = Object.freeze([
  'created', 'inspecting', 'waiting_action', 'applying', 'checking', 'committing',
  'deploying', 'completed', 'failed', 'cancelled', 'rolled_back', 'uncertain',
]);
export const ACTION_RECEIPT_SETTLEMENTS = Object.freeze([
  'succeeded', 'failed', 'cancelled', 'uncertain',
]);
export const PLAN_GROUPS = Object.freeze([
  'created', 'updated', 'deleted', 'preserved', 'unchanged', 'skipped', 'conflicts',
]);

const STATUS_SET = new Set(RUN_SESSION_STATUSES);
const RECEIPT_SET = new Set(ACTION_RECEIPT_SETTLEMENTS);
const OUTPUT_SOURCES = new Set(['checks', 'deploy']);
const OUTPUT_STREAMS = new Set(['stdout', 'stderr', 'event']);
const CHANGED_GROUPS = new Set(['created', 'updated', 'deleted']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rolled_back', 'uncertain']);

export function createRunSessionRecord({
  runId,
  binding,
  kind,
  seriesId = null,
  operationId = null,
  status = 'created',
  correlation = null,
  executionManifest = null,
  publicSummary = {},
}, timestamp) {
  const record = {
    version: RUN_SESSION_VERSION,
    revision: 1,
    binding: normalizeBinding(binding),
    run: {
      runId: cleanId(runId, 'run ID'),
      kind: cleanId(kind, 'run kind'),
      seriesId: nullableId(seriesId, 'series ID'),
      operationId: nullableId(operationId, 'operation ID'),
      status: validateStatus(status),
      correlation: cloneJson(correlation),
      createdAt: validateTimestamp(timestamp, 'creation timestamp'),
      updatedAt: timestamp,
      completedAt: TERMINAL_STATUSES.has(status) ? timestamp : null,
    },
    executionManifest: validateExecutionManifest(executionManifest),
    publicSummary: normalizeObject(publicSummary, 'public summary'),
    outputs: [],
    actions: [],
  };
  return validateRunSessionRecord(record, { expectedRunId: runId, stored: false });
}

export function validateRunSessionRecord(value, { expectedRunId = null, stored = true } = {}) {
  try {
    if (!isPlainObject(value) || value.version !== RUN_SESSION_VERSION) throw new TypeError('Run session version is invalid.');
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new TypeError('Run session revision is invalid.');
    const binding = normalizeBinding(value.binding);
    const run = normalizeRun(value.run, expectedRunId);
    const executionManifest = validateExecutionManifest(value.executionManifest);
    const publicSummary = normalizeObject(value.publicSummary, 'public summary');
    const outputs = normalizeOutputs(value.outputs);
    const actions = normalizeActions(value.actions);
    return cloneJson({
      version: RUN_SESSION_VERSION,
      revision: value.revision,
      binding,
      run,
      executionManifest,
      publicSummary,
      outputs,
      actions,
    });
  } catch (error) {
    if (!stored || error?.code === 'SERVER_STORAGE_CORRUPT') throw error;
    throw runSessionError('Run session sidecar is corrupt.', 'SERVER_STORAGE_CORRUPT', 500, null, error);
  }
}

export function validateExecutionManifest(value) {
  if (value == null) return null;
  const manifest = normalizeObject(value, 'execution manifest');
  for (const group of PLAN_GROUPS) validateManifestItems(groupItems(manifest, group), group);
  const changedPaths = new Set();
  for (const group of ['created', 'updated', 'deleted']) {
    for (const value of groupItems(manifest, group)) {
      const item = normalizeManifestItem(value, group);
      if (changedPaths.has(item.path)) throw new TypeError('Changed manifest paths must be unique.');
      changedPaths.add(item.path);
    }
  }
  for (const key of ['files', 'items']) {
    if (manifest[key] !== undefined) validateManifestItems(manifest[key], key);
  }
  return manifest;
}

export function manifestGroupItems(manifest, group = null) {
  if (!manifest) return [];
  if (group !== null && !PLAN_GROUPS.includes(group)) {
    throw runSessionError('Plan group is invalid.', 'INVALID_PLAN_GROUP', 400);
  }
  if (group !== null) return groupItems(manifest, group).map((item) => normalizeManifestItem(item, group));
  const values = [];
  for (const name of PLAN_GROUPS) {
    for (const item of groupItems(manifest, name)) values.push(normalizeManifestItem(item, name));
  }
  if (values.length) return values;
  const generic = Array.isArray(manifest.files) ? manifest.files : Array.isArray(manifest.items) ? manifest.items : [];
  return generic.map((item) => normalizeManifestItem(item, item?.kind ?? 'updated'));
}

export function findManifestDiffItem(manifest, requestedPath) {
  const normalized = normalizeManifestPath(requestedPath);
  for (const group of ['created', 'updated', 'deleted']) {
    const found = groupItems(manifest, group)
      .map((item) => normalizeManifestItem(item, group))
      .find((item) => item.path === normalized);
    if (found) return found;
  }
  const generic = Array.isArray(manifest?.files) ? manifest.files : Array.isArray(manifest?.items) ? manifest.items : [];
  return generic
    .map((item) => normalizeManifestItem(item, item?.kind ?? 'updated'))
    .find((item) => CHANGED_GROUPS.has(item.kind) && item.path === normalized) ?? null;
}

export function normalizeManifestPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\\')) {
    throw runSessionError('Manifest path is invalid.', 'INVALID_MANIFEST_PATH', 400);
  }
  if (value.includes('\0') || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    throw runSessionError('Manifest path must be a normalized relative path.', 'INVALID_MANIFEST_PATH', 400);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw runSessionError('Manifest path must be a normalized relative path.', 'INVALID_MANIFEST_PATH', 400);
  }
  return value;
}

export function cloneJson(value) {
  assertJson(value, 0);
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

export function validateStatus(value) {
  if (!STATUS_SET.has(value)) throw runSessionError('Run status is invalid.', 'INVALID_RUN_STATUS', 400);
  return value;
}

export function terminalRunStatus(value) {
  return TERMINAL_STATUSES.has(value);
}

export function runSessionError(message, code, status = 400, details = null, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code, status, expose: status < 500, detail: message, ...(details ? { details } : {}),
  });
}

function normalizeBinding(value) {
  if (!isPlainObject(value)) throw new TypeError('Run binding is required.');
  const projectId = cleanId(value.projectId, 'project ID');
  if (typeof value.projectPath !== 'string' || !path.isAbsolute(value.projectPath)) {
    throw new TypeError('Run project path must be absolute.');
  }
  if (!Number.isSafeInteger(value.workflowRevision) || value.workflowRevision < 0) {
    throw new TypeError('Workflow revision is invalid.');
  }
  const blobId = value.blobId ?? null;
  const blobSha256 = value.blobSha256 ?? null;
  if ((blobId === null) !== (blobSha256 === null)) throw new TypeError('Blob ID and hash must be bound together.');
  if (blobId !== null && (!/^[a-f0-9]{64}$/.test(blobSha256) || blobId !== `sha256:${blobSha256}`)) {
    throw new TypeError('Blob binding is invalid.');
  }
  return { projectId, projectPath: value.projectPath, workflowRevision: value.workflowRevision, blobId, blobSha256 };
}

function normalizeRun(value, expectedRunId) {
  if (!isPlainObject(value)) throw new TypeError('Run metadata is invalid.');
  const runId = cleanId(value.runId, 'run ID');
  if (expectedRunId !== null && runId !== expectedRunId) throw new TypeError('Run ID does not match its directory.');
  return {
    runId,
    kind: cleanId(value.kind, 'run kind'),
    seriesId: nullableId(value.seriesId, 'series ID'),
    operationId: nullableId(value.operationId, 'operation ID'),
    status: validateStatus(value.status),
    correlation: cloneJson(value.correlation),
    createdAt: validateTimestamp(value.createdAt, 'creation timestamp'),
    updatedAt: validateTimestamp(value.updatedAt, 'update timestamp'),
    completedAt: value.completedAt == null ? null : validateTimestamp(value.completedAt, 'completion timestamp'),
  };
}

function normalizeOutputs(values) {
  if (!Array.isArray(values)) throw new TypeError('Run outputs are invalid.');
  let previous = 0;
  return values.map((value) => {
    if (!isPlainObject(value) || !Number.isSafeInteger(value.sequence) || value.sequence <= previous) throw new TypeError('Output sequence is invalid.');
    previous = value.sequence;
    if (!OUTPUT_SOURCES.has(value.source) || !OUTPUT_STREAMS.has(value.stream) || typeof value.text !== 'string') throw new TypeError('Output record is invalid.');
    if (typeof value.truncated !== 'boolean' || !Number.isSafeInteger(value.omittedBytes) || value.omittedBytes < 0) throw new TypeError('Output truncation metadata is invalid.');
    return {
      sequence: value.sequence, source: value.source, stream: value.stream, text: value.text,
      commandId: nullableId(value.commandId, 'command ID'), checkId: nullableId(value.checkId, 'check ID'),
      truncated: value.truncated, omittedBytes: value.omittedBytes,
      createdAt: validateTimestamp(value.createdAt, 'output timestamp'),
    };
  });
}

function normalizeActions(values) {
  if (!Array.isArray(values)) throw new TypeError('Run action intents are invalid.');
  const ids = new Set();
  return values.map((value) => {
    if (!isPlainObject(value) || !isPlainObject(value.intent)) throw new TypeError('Action intent is invalid.');
    const intent = value.intent;
    const actionIntentId = cleanId(intent.actionIntentId, 'action intent ID');
    if (ids.has(actionIntentId)) throw new TypeError('Action intent IDs must be unique.');
    ids.add(actionIntentId);
    if (typeof intent.idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(intent.idempotencyKey)) throw new TypeError('Action idempotency key is invalid.');
    if (!/^[a-f0-9]{64}$/.test(String(intent.requestFingerprint ?? ''))) throw new TypeError('Action fingerprint is invalid.');
    if (!Number.isSafeInteger(intent.surfaceRevision) || intent.surfaceRevision < 0) throw new TypeError('Surface revision is invalid.');
    const normalizedIntent = {
      actionIntentId, actionId: cleanId(intent.actionId, 'action ID'), idempotencyKey: intent.idempotencyKey,
      requestFingerprint: intent.requestFingerprint, surfaceRevision: intent.surfaceRevision,
      input: cloneJson(intent.input), recordedAt: validateTimestamp(intent.recordedAt, 'intent timestamp'),
    };
    const dispatch = normalizeDispatch(value.dispatch);
    const receipt = normalizeReceipt(value.receipt);
    if (receipt && ['succeeded', 'failed'].includes(receipt.settlement) && !dispatch) throw new TypeError('Settled action was never dispatched.');
    return { intent: normalizedIntent, dispatch, receipt };
  });
}

function normalizeDispatch(value) {
  if (value == null) return null;
  if (!isPlainObject(value) || !Number.isSafeInteger(value.attempt) || value.attempt < 1) throw new TypeError('Action dispatch is invalid.');
  return { attempt: value.attempt, dispatchedAt: validateTimestamp(value.dispatchedAt, 'dispatch timestamp') };
}

function normalizeReceipt(value) {
  if (value == null) return null;
  if (!isPlainObject(value) || !RECEIPT_SET.has(value.settlement)) throw new TypeError('Action receipt is invalid.');
  return {
    settlement: value.settlement,
    response: cloneJson(value.response), error: cloneJson(value.error), evidence: cloneJson(value.evidence),
    reconciled: Boolean(value.reconciled), recordedAt: validateTimestamp(value.recordedAt, 'receipt timestamp'),
  };
}

function groupItems(manifest, group) {
  const value = manifest?.[group] ?? manifest?.groups?.[group] ?? [];
  if (!Array.isArray(value)) throw new TypeError(`Manifest ${group} group is invalid.`);
  if (value.length) return value;
  const generic = Array.isArray(manifest?.files) ? manifest.files : Array.isArray(manifest?.items) ? manifest.items : [];
  return generic.filter((item) => item?.kind === group);
}

function validateManifestItems(values, group) {
  if (!Array.isArray(values)) throw new TypeError(`Manifest ${group} entries are invalid.`);
  for (const item of values) normalizeManifestItem(item, group);
}

function normalizeManifestItem(value, fallbackKind) {
  const item = typeof value === 'string' ? { path: value } : value;
  if (!isPlainObject(item)) throw new TypeError('Manifest entry is invalid.');
  const result = cloneJson(item);
  result.path = normalizeManifestPath(item.path);
  result.kind = typeof item.kind === 'string' ? item.kind : fallbackKind;
  for (const key of ['sourcePath', 'currentPath']) {
    if (item[key] != null && (typeof item[key] !== 'string' || !path.isAbsolute(item[key]))) throw new TypeError(`Manifest ${key} is invalid.`);
  }
  return result;
}

function normalizeObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`Run ${label} must be an object.`);
  return cloneJson(value);
}

function nullableId(value, label) {
  return value == null ? null : cleanId(value, label);
}

function cleanId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new TypeError(`Run ${label} is invalid.`);
  return value;
}

function validateTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`Run ${label} is invalid.`);
  return value;
}

function assertJson(value, depth) {
  if (depth > 64) throw new TypeError('Run data is nested too deeply.');
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) return value.forEach((item) => assertJson(item, depth + 1));
  if (!isPlainObject(value)) throw new TypeError('Run data must be JSON-compatible.');
  for (const item of Object.values(value)) assertJson(item, depth + 1);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
