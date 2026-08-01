import { createHash, randomUUID } from 'node:crypto';
import { createProblem, ZipflowApiError } from '../protocol/errors.js';
import {
  ActionRegistry,
  SEMANTIC_ACTION_IDS,
} from './action-registry.js';
import { SurfaceProjector } from './surface-projector.js';
import { resolveWorkflowSurfaceKind } from './workflow-surface-state.js';

/**
 * Repository port consumed by WorkflowSession.
 *
 * load(runId) returns null or a detached JSON record shaped as:
 *   { runId, revision, snapshot, privateState?, actions }
 * `revision` is both the compare-and-swap revision and semantic surface revision.
 * `actions` is an append-only journal of { intent, dispatch, receipt } entries.
 * `privateState` is opaque executable data; it is passed only to the executor and
 * is never projected or returned from dispatchAction.
 *
 * compareAndSwap(runId, expectedRevision, nextRecord) must atomically compare the
 * durable revision and replace the record. It returns false on mismatch, true on
 * success, or the detached persisted record. It must never report success before
 * the replacement is durable.
 *
 * @typedef {{
 *   load(runId: string): Promise<object|null>,
 *   compareAndSwap(runId: string, expectedRevision: number, nextRecord: object): Promise<boolean|object>
 * }} WorkflowSessionRepository
 */

/**
 * Executor port consumed by WorkflowSession.
 *
 * executeAction(request) is called only after its intent is durably stored. It
 * receives JSON copies of the authoritative snapshot/input and returns a JSON
 * object `{ snapshot, privateState?, result?, evidence? }`. `snapshot` is the
 * authoritative post-side-effect semantic snapshot. `privateState` defaults to
 * the prior value and is stored atomically with snapshot and receipt.
 * Arbitrary commands are deliberately absent from this port.
 *
 * @typedef {{executeAction(request: object): Promise<object>}} WorkflowActionExecutor
 */

function fail(code, message, details = {}, options = {}) {
  throw new ZipflowApiError(createProblem(code, { message, details }), options);
}

export class WorkflowSession {
  #repository;
  #executor;
  #clock;
  #idFactory;
  #registry;
  #projector;

  /**
   * @param {{
   *   repository: WorkflowSessionRepository,
   *   executor: WorkflowActionExecutor,
   *   clock?: () => Date|string,
   *   idFactory?: () => string
   * }} options
   */
  constructor({
    repository,
    executor,
    clock = () => new Date(),
    idFactory = randomUUID,
  } = {}) {
    if (!repository || typeof repository.load !== 'function'
      || typeof repository.compareAndSwap !== 'function') {
      throw new TypeError('WorkflowSession requires a load/compareAndSwap repository.');
    }
    if (!executor || typeof executor.executeAction !== 'function') {
      throw new TypeError('WorkflowSession requires an executeAction executor.');
    }
    if (typeof clock !== 'function' || typeof idFactory !== 'function') {
      throw new TypeError('WorkflowSession clock and idFactory must be functions.');
    }

    this.#repository = repository;
    this.#executor = executor;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#registry = new ActionRegistry();
    for (const actionId of SEMANTIC_ACTION_IDS) {
      this.#registry.register(actionId, (request) => this.#executePersistedAction(request));
    }
    this.#projector = new SurfaceProjector({ actionRegistry: this.#registry });
  }

  async getSurface(runId) {
    return this.projectRecord(await this.#load(runId));
  }

  projectRecord(record) {
    const current = normalizeRecord(record);
    const blocking = blockingAction(current.actions);
    const actionState = blocking?.receipt?.settlement === 'uncertain' ? 'uncertain'
      : blocking ? 'active' : null;
    const run = {
      ...(current.snapshot.run ?? {}),
      id: current.snapshot.run?.id ?? current.snapshot.run?.runId ?? current.runId,
      kind: current.kind,
    };
    const projection = {
      ...cloneJson(current.snapshot),
      run,
      surfaceRevision: current.revision,
      surfaceKind: resolveWorkflowSurfaceKind(current.snapshot, { actionState }),
    };

    if (actionState === 'active') {
      projection.operation = {
        ...(projection.operation ?? {}),
        id: projection.operation?.id ?? blocking.intent.actionIntentId,
        kind: projection.operation?.kind ?? blocking.intent.actionId,
        settlement: 'active',
        message: 'A durable workflow action is in progress.',
      };
    } else if (actionState === 'uncertain') {
      projection.error = {
        code: 'ACTION_OUTCOME_UNCERTAIN',
        message: 'The previous action outcome is uncertain and requires reconciliation.',
        retryable: false,
      };
    }

    return this.#projector.project(projection);
  }

  async dispatchAction({
    runId,
    actionId,
    expectedRevision,
    input = {},
    idempotencyKey,
    context = null,
  } = {}) {
    validateRunId(runId);
    validateIdempotencyKey(idempotencyKey);
    const safeInput = actionInput(input);
    const requestFingerprint = workflowActionFingerprint({
      runId,
      actionId,
      expectedRevision,
      input: safeInput,
    });
    const record = await this.#load(runId);
    const matching = actionByIdempotencyKey(record.actions, idempotencyKey);

    if (matching) {
      if (matching.intent.requestFingerprint !== requestFingerprint) {
        fail('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used for another action request.', {
          actionId,
          originalActionId: matching.intent.actionId,
        });
      }
      if (matching.receipt && matching.receipt.settlement !== 'uncertain') {
        return actionResponse(record, matching, this.projectRecord(record), true);
      }
    }

    const surface = this.projectRecord(record);
    const blocking = blockingAction(record.actions);
    if (blocking) {
      if (expectedRevision !== surface.revision) {
        await this.#registry.dispatch({ surface, actionId, expectedRevision, input: safeInput });
      }
      fail('OPERATION_BUSY', 'A durable action intent must be reconciled before another action can run.', {
        actionIntentId: blocking.intent.actionIntentId,
        actionId: blocking.intent.actionId,
        state: blocking.receipt?.settlement ?? 'active',
      });
    }

    return this.#registry.dispatch({
      surface,
      actionId,
      expectedRevision,
      input: safeInput,
      context: {
        record,
        idempotencyKey,
        requestFingerprint,
        callerContext: context,
      },
    });
  }

  dispatch(request) {
    return this.dispatchAction(request);
  }

  async #executePersistedAction({ action, input, context }) {
    const original = context.record;
    const recordedAt = timestamp(this.#clock);
    const intent = {
      actionIntentId: validateGeneratedId(this.#idFactory()),
      actionId: action.id,
      idempotencyKey: context.idempotencyKey,
      requestFingerprint: context.requestFingerprint,
      surfaceRevision: original.revision,
      input: cloneJson(input),
      recordedAt,
    };
    const journalEntry = {
      intent,
      dispatch: { attempt: 1, dispatchedAt: recordedAt },
      receipt: null,
    };
    const withIntent = {
      ...cloneJson(original),
      revision: original.revision + 1,
      actions: [...cloneJson(original.actions), journalEntry],
    };
    const persistedIntent = await this.#compareAndSwap(original, withIntent);
    if (!persistedIntent) return this.#throwConcurrentRevision(original.runId, original.revision);

    let outcome;
    try {
      outcome = normalizeOutcome(await this.#executor.executeAction({
        runId: original.runId,
        actionId: action.id,
        actionKind: action.kind,
        input: cloneJson(input),
        intent: cloneJson(intent),
        snapshot: cloneJson(original.snapshot),
        privateState: cloneJson(original.privateState),
        context: context.callerContext,
      }), original.privateState);
    } catch (error) {
      await this.#persistUncertain(persistedIntent, intent, error);
      fail('INTERNAL_ERROR', 'The action outcome is uncertain and requires reconciliation.', {
        actionId: action.id,
        actionIntentId: intent.actionIntentId,
      }, { cause: error });
    }

    const receipt = {
      settlement: 'succeeded',
      response: { actionId: action.id, result: outcome.result },
      error: null,
      evidence: outcome.evidence,
      reconciled: false,
      recordedAt: timestamp(this.#clock),
    };
    const settled = settleRecord(
      persistedIntent,
      intent.actionIntentId,
      receipt,
      outcome.snapshot,
      outcome.privateState,
    );
    const persistedReceipt = await this.#compareAndSwap(persistedIntent, settled);
    if (!persistedReceipt) return this.#throwConcurrentRevision(original.runId, persistedIntent.revision);
    const entry = actionByIntentId(persistedReceipt.actions, intent.actionIntentId);
    return actionResponse(persistedReceipt, entry, this.projectRecord(persistedReceipt), false);
  }

  async #persistUncertain(record, intent, error) {
    const receipt = {
      settlement: 'uncertain',
      response: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The executor did not provide a durable action outcome.',
      },
      evidence: null,
      reconciled: false,
      recordedAt: timestamp(this.#clock),
    };
    const snapshot = {
      ...cloneJson(record.snapshot),
      run: {
        ...(record.snapshot.run ?? {}),
        status: 'uncertain',
        attention: 'error',
      },
    };
    const uncertain = settleRecord(
      record,
      intent.actionIntentId,
      receipt,
      snapshot,
      record.privateState,
    );
    const persisted = await this.#compareAndSwap(record, uncertain);
    if (!persisted) await this.#throwConcurrentRevision(record.runId, record.revision);
    return error;
  }

  async #compareAndSwap(current, next) {
    const result = await this.#repository.compareAndSwap(
      current.runId,
      current.revision,
      cloneJson(next),
    );
    if (result === false || result === null) return null;
    if (result === true) return normalizeRecord(next);
    return normalizeRecord(result);
  }

  async #throwConcurrentRevision(runId, expectedRevision) {
    const current = await this.#load(runId);
    fail('STALE_REVISION', 'The workflow surface changed before the action intent was committed.', {
      expectedRevision,
      currentRevision: current.revision,
    });
  }

  async #load(runId) {
    validateRunId(runId);
    const record = await this.#repository.load(runId);
    if (record === null || record === undefined) {
      fail('RUN_NOT_FOUND', 'The requested workflow run does not exist.', { runId });
    }
    try {
      const normalized = normalizeRecord(record);
      if (normalized.runId !== runId) throw new TypeError('Workflow record runId does not match.');
      return normalized;
    } catch (error) {
      fail('INTERNAL_ERROR', 'The durable workflow session record is invalid.', { runId }, { cause: error });
    }
  }
}

export function workflowActionFingerprint(request) {
  return createHash('sha256').update(stableJson(request)).digest('hex');
}

function normalizeRecord(value) {
  if (!isPlainObject(value)
    || typeof value.runId !== 'string'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !isPlainObject(value.snapshot)
    || !Array.isArray(value.actions)) {
    throw new TypeError('Invalid WorkflowSession record.');
  }
  assertPublicJson(value.snapshot, 'workflow snapshot');
  return cloneJson({ ...value, privateState: value.privateState ?? null });
}

function normalizeOutcome(value, previousPrivateState) {
  if (!isPlainObject(value) || !isPlainObject(value.snapshot)) {
    throw new TypeError('Workflow executor must return an authoritative snapshot.');
  }
  const result = value.result ?? null;
  const evidence = value.evidence ?? null;
  assertPublicJson(value.snapshot, 'workflow snapshot');
  assertPublicJson(result, 'action result');
  assertPublicJson(evidence, 'action evidence');
  return {
    snapshot: cloneJson(value.snapshot),
    privateState: cloneJson(Object.hasOwn(value, 'privateState')
      ? value.privateState
      : previousPrivateState),
    result: cloneJson(result),
    evidence: cloneJson(evidence),
  };
}

function settleRecord(record, actionIntentId, receipt, snapshot, privateState) {
  const found = actionByIntentId(record.actions, actionIntentId);
  if (!found || found.receipt) throw new TypeError('Action intent cannot be settled.');
  return {
    ...cloneJson(record),
    revision: record.revision + 1,
    snapshot: cloneJson(snapshot),
    privateState: cloneJson(privateState),
    actions: record.actions.map((entry) => entry.intent.actionIntentId === actionIntentId
      ? { ...cloneJson(entry), receipt: cloneJson(receipt) }
      : cloneJson(entry)),
  };
}

function actionResponse(record, entry, surface, replayed) {
  return {
    replayed,
    settlement: entry.receipt.settlement,
    receipt: cloneJson(entry.receipt),
    surface,
    revision: record.revision,
  };
}

function actionByIdempotencyKey(actions, key) {
  const matches = actions.filter(({ intent }) => intent?.idempotencyKey === key);
  if (matches.length > 1) throw new TypeError('Duplicate durable idempotency keys.');
  return matches[0] ?? null;
}

function actionByIntentId(actions, actionIntentId) {
  return actions.find(({ intent }) => intent?.actionIntentId === actionIntentId) ?? null;
}

function blockingAction(actions) {
  return [...actions].reverse().find((entry) => entry.receipt === null
    || (entry.receipt?.settlement === 'uncertain' && entry.receipt.reconciled !== true)) ?? null;
}

function actionInput(input) {
  try {
    return cloneJson(input);
  } catch (error) {
    fail('ACTION_INPUT_INVALID', 'Action input must be a JSON value.', { reason: error.message });
  }
}

function validateRunId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new TypeError('A runId is required.');
  }
}

function validateIdempotencyKey(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value)) {
    fail('IDEMPOTENCY_REQUIRED', 'A visible ASCII idempotency key is required.');
  }
}

function validateGeneratedId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new TypeError('Generated action intent ID is invalid.');
  }
  return value;
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('WorkflowSession clock returned an invalid date.');
  return date.toISOString();
}

function stableJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isPlainObject(value)) throw new TypeError('Value is not JSON-compatible.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function assertPublicJson(value, label) {
  if (typeof value === 'string') {
    if (isAbsoluteFilesystemPath(value)) {
      throw new TypeError(`${label} must not contain absolute filesystem paths.`);
    }
    return;
  }
  if (value === null || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    for (const item of value) assertPublicJson(item, label);
    return;
  }
  if (!isPlainObject(value)) throw new TypeError(`${label} must be JSON-compatible.`);
  for (const item of Object.values(value)) assertPublicJson(item, label);
}

function isAbsoluteFilesystemPath(value) {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) return true;
  return value.startsWith('/') && !value.startsWith('/v1/');
}

function cloneJson(value) {
  return JSON.parse(stableJson(value));
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
