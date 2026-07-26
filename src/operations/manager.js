import { operationCapabilities, operationState } from './state.js';

export class OperationManager {
  constructor({ onChange = () => {}, forceStop = async () => {} } = {}) {
    this.onChange = onChange;
    this.forceStop = forceStop;
    this.current = null;
    this.nextId = 1;
    this.idleWaiters = new Set();
    this.safeWaiters = new Set();
  }

  begin({ kind, label, cancellable = true, critical = false, onCancel = null, onForceCancel = null } = {}) {
    if (this.current) {
      throw new OperationBusyError(kind || 'operation', this.current.kind);
    }
    const abortController = new AbortController();
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const operation = {
      id: this.nextId++,
      kind: kind || 'operation',
      label: label || 'Working',
      phase: '',
      cancellable: Boolean(cancellable),
      critical: Boolean(critical),
      cancelRequested: false,
      cancelling: false,
      forceRequested: false,
      startedAt: Date.now(),
      abortController,
      onCancel,
      onForceCancel,
      completion,
      resolveCompletion,
    };
    this.current = operation;
    this.emit();
    let finished = false;
    const finish = (outcome = null) => {
      if (finished) return;
      finished = true;
      operation.outcome = normalizeOutcome(outcome, operation);
      operation.critical = false;
      if (this.current?.id === operation.id) {
        this.current = null;
        operation.resolveCompletion(this.publicSnapshot(operation));
        this.emit();
      } else operation.resolveCompletion(this.publicSnapshot(operation));
    };
    return {
      id: operation.id,
      signal: abortController.signal,
      completion,
      update: (changes = {}) => {
        if (this.current?.id !== operation.id) return;
        const { state: _ignoredState, outcome: _ignoredOutcome, ...safeChanges } = changes;
        Object.assign(operation, safeChanges);
        if (!operation.critical && operation.cancelRequested && !operation.abortController.signal.aborted) {
          operation.abortController.abort('cancelled');
        }
        this.emit();
      },
      enterCritical: (phase = operation.phase) => {
        if (this.current?.id !== operation.id) return;
        operation.critical = true;
        if (phase) operation.phase = phase;
        this.emit();
      },
      leaveCritical: (phase = operation.phase) => {
        if (this.current?.id !== operation.id) return;
        operation.critical = false;
        if (phase) operation.phase = phase;
        if (operation.cancelRequested && !operation.abortController.signal.aborted) operation.abortController.abort('cancelled');
        this.emit();
      },
      isCancellationRequested: () => Boolean(operation.cancelRequested),
      abort: () => {
        if (this.current?.id !== operation.id || operation.abortController.signal.aborted) return;
        operation.cancelRequested = true;
        operation.cancelling = true;
        operation.abortController.abort('cancelled');
        this.emit();
      },
      finish,
      handoff: (callback) => {
        if (typeof callback !== 'function') throw new TypeError('Operation handoff requires a callback.');
        finish('completed');
        return callback();
      },
    };
  }

  async run(options, callback) {
    if (typeof callback !== 'function') throw new TypeError('Operation run requires a callback.');
    const operation = this.begin(options);
    try {
      const result = await callback(operation);
      operation.finish('completed');
      return result;
    } catch (error) {
      operation.finish(error?.code === 'cancelled' ? 'cancelled' : 'failed');
      throw error;
    }
  }

  async requestCancellation() {
    const operation = this.current;
    if (!operation) return { handled: false, idle: true };
    if (!operation.cancellable) {
      operation.cancelRequested = true;
      operation.cancelling = true;
      this.emit();
      await operation.onCancel?.().catch(() => {});
      return { handled: true, waitingForCritical: true, operation: this.snapshot() };
    }
    if (!operation.cancelRequested) {
      operation.cancelRequested = true;
      operation.cancelling = true;
      if (!operation.critical && !operation.abortController.signal.aborted) operation.abortController.abort('cancelled');
      this.emit();
      await operation.onCancel?.().catch(() => {});
    }
    return {
      handled: true,
      waitingForCritical: Boolean(operation.critical),
      cancelling: !operation.critical,
      operation: this.snapshot(),
    };
  }

  async interrupt() {
    const operation = this.current;
    if (!operation) return { handled: false, exited: true };
    if (!operation.cancellable || (operation.critical && !operation.cancelling)) {
      operation.cancelRequested = true;
      operation.cancelling = true;
      this.emit();
      await operation.onCancel?.().catch(() => {});
      return { handled: true, waitingForCritical: true, operation: this.snapshot() };
    }
    if (operation.cancelling) {
      operation.forceRequested = true;
      if (!operation.critical && !operation.abortController.signal.aborted) operation.abortController.abort('force-cancelled');
      this.emit();
      await operation.onForceCancel?.().catch(() => {});
      await this.forceStop().catch(() => {});
      return { handled: true, forced: true, operation: this.snapshot() };
    }
    operation.cancelRequested = true;
    operation.cancelling = true;
    this.emit();
    operation.abortController.abort('cancelled');
    await operation.onCancel?.().catch(() => {});
    return { handled: true, cancelling: true, operation: this.snapshot() };
  }

  waitForSafeBoundary({ timeoutMs = 0 } = {}) {
    if (!this.current || !this.current.critical) return Promise.resolve(true);
    return this.waitFor(this.safeWaiters, () => !this.current || !this.current.critical, timeoutMs);
  }

  waitForIdle({ timeoutMs = 0 } = {}) {
    if (!this.current) return Promise.resolve(true);
    return this.waitFor(this.idleWaiters, () => !this.current, timeoutMs);
  }

  waitFor(waiters, predicate, timeoutMs) {
    return new Promise((resolve) => {
      let timer = null;
      const waiter = () => {
        if (!predicate()) return false;
        if (timer) clearTimeout(timer);
        waiters.delete(waiter);
        resolve(true);
        return true;
      };
      waiters.add(waiter);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve(false);
        }, timeoutMs);
      }
      waiter();
    });
  }

  snapshot() {
    return this.current ? this.publicSnapshot(this.current) : null;
  }

  publicSnapshot(operation) {
    const {
      abortController, onCancel, onForceCancel, completion, resolveCompletion, ...publicState
    } = operation;
    const state = operationState(publicState);
    return {
      ...publicState,
      state,
      capabilities: operationCapabilities({ ...publicState, state }),
      elapsedMs: Date.now() - publicState.startedAt,
    };
  }

  emit() {
    this.onChange(this.snapshot());
    for (const waiter of [...this.safeWaiters]) waiter();
    for (const waiter of [...this.idleWaiters]) waiter();
  }
}

export function cancelledError(message = 'Operation cancelled.') {
  const error = new Error(message);
  error.code = 'cancelled';
  return error;
}

export function throwIfCancelled(signal, message = 'Operation cancelled.') {
  if (signal?.aborted) throw cancelledError(message);
}

export class OperationBusyError extends Error {
  constructor(requestedOperation = 'operation', activeOperation = 'operation') {
    super(`Cannot start ${requestedOperation} while ${activeOperation} is active.`);
    this.name = 'OperationBusyError';
    this.code = 'operation-busy';
    this.requestedOperation = requestedOperation;
    this.activeOperation = activeOperation;
  }
}

export function isOperationBusyError(error) {
  return error?.code === 'operation-busy' || error instanceof OperationBusyError;
}

function normalizeOutcome(value, operation) {
  if (['completed', 'failed', 'cancelled'].includes(value)) return value;
  return operation.cancelRequested || operation.abortController.signal.aborted ? 'cancelled' : 'completed';
}
