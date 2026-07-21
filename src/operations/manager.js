export class OperationManager {
  constructor({ onChange = () => {}, forceStop = async () => {} } = {}) {
    this.onChange = onChange;
    this.forceStop = forceStop;
    this.current = null;
    this.nextId = 1;
  }

  begin({ kind, label, cancellable = true, critical = false, onCancel = null, onForceCancel = null } = {}) {
    if (this.current) {
      throw new Error(`Cannot start ${kind || 'operation'} while ${this.current.kind} is active.`);
    }
    const abortController = new AbortController();
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
    };
    this.current = operation;
    this.emit();
    let finished = false;
    return {
      id: operation.id,
      signal: abortController.signal,
      update: (changes = {}) => {
        if (this.current?.id !== operation.id) return;
        Object.assign(operation, changes);
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
      finish: () => {
        if (finished) return;
        finished = true;
        if (this.current?.id === operation.id) {
          this.current = null;
          this.emit();
        }
      },
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

  snapshot() {
    if (!this.current) return null;
    const { abortController, onCancel, onForceCancel, ...publicState } = this.current;
    return { ...publicState, elapsedMs: Date.now() - publicState.startedAt };
  }

  emit() {
    this.onChange(this.snapshot());
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
