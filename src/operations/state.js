export const OPERATION_STATES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  CRITICAL: 'critical',
});

export function operationState(operation) {
  if (!operation) return OPERATION_STATES.IDLE;
  if (operation.cancelRequested) return OPERATION_STATES.CANCELLING;
  if (operation.critical) return OPERATION_STATES.CRITICAL;
  return OPERATION_STATES.RUNNING;
}

export function operationCapabilities(operation) {
  const idle = !operation;
  return Object.freeze({
    canApply: idle,
    canCancel: !idle && Boolean(operation?.cancellable),
    canStartLlm: idle,
    canRunChecks: idle,
    canCommit: idle,
    canDeploy: idle,
    canOpenSettings: idle,
  });
}

export function operationBlocksActions(operation) {
  return Boolean(operation);
}
