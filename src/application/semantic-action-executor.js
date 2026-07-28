import { randomUUID } from 'node:crypto';
import {
  publicPlanFromExecutable,
  updateExecutableDecision,
} from './archive-runner.js';
import { inspectExecutableRollback } from './project-mutation-runner.js';
import {
  deploymentAvailable,
  nextPostCommitAttention,
} from './post-apply-runner.js';

export class SemanticActionExecutor {
  constructor({ operations, createOperationId = randomUUID } = {}) {
    if (!operations?.begin || !operations?.requestCancellation) {
      throw new TypeError('Semantic action executor requires an operation registry.');
    }
    this.operations = operations;
    this.createOperationId = createOperationId;
    this.pendingHandles = new Map();
  }

  async executeAction(request) {
    const snapshot = clone(request.snapshot);
    const privateState = clone(request.privateState);
    assertRunBinding(request.runId, snapshot, privateState);
    switch (request.actionId) {
      case 'select-archive-root':
        return this.startOperation(request, snapshot, privateState, {
          kind: 'archive_root',
          status: 'inspecting',
          input: { rootId: request.input.rootId },
        });
      case 'acknowledge-archive-safety':
        return acknowledgeSafety(snapshot, privateState);
      case 'use-archive':
        return decidePath(snapshot, privateState, request.input.path, 'archive');
      case 'keep-local':
        return decidePath(snapshot, privateState, request.input.path, 'keep');
      case 'resolve-conflict':
        return decidePath(snapshot, privateState, request.input.path, request.input.decision);
      case 'approve-plan':
        assertPlanReady(privateState);
        return this.startOperation(request, snapshot, privateState, {
          kind: 'apply',
          status: 'applying',
        });
      case 'retry-checks':
        return this.startOperation(request, snapshot, privateState, {
          kind: 'checks',
          status: 'checking',
        });
      case 'prepare-commit':
        return immediate(transition(snapshot, {
          status: 'waiting_action',
          attention: 'commit_message',
        }), privateState);
      case 'commit':
        return this.startOperation(request, snapshot, privateState, {
          kind: 'commit',
          status: 'committing',
          input: { message: request.input.message },
          cancellable: false,
        });
      case 'continue-without-commit':
        return continueAfterCommit(snapshot, privateState);
      case 'deploy':
        assertDeployment(privateState.workflow);
        return this.startOperation(request, snapshot, privateState, {
          kind: 'deploy',
          status: 'deploying',
          cancellable: false,
        });
      case 'skip-deploy':
        snapshot.deploy = {
          ...(snapshot.deploy ?? {}),
          skipped: true,
        };
        return immediate(transition(snapshot, { status: 'completed', attention: null }), privateState);
      case 'rollback':
        return this.rollback(request, snapshot, privateState);
      case 'cancel-operation':
        return this.cancel(snapshot, privateState);
      case 'retry-run':
        return this.retry(request, snapshot, privateState);
      case 'finish':
      case 'dismiss-error':
        return immediate(snapshot, privateState);
      default:
        throw actionError('The semantic action is not executable for this run.', 'ACTION_NOT_AVAILABLE', 409);
    }
  }

  takeOperationHandle(operationId) {
    const handle = this.pendingHandles.get(operationId) ?? null;
    this.pendingHandles.delete(operationId);
    return handle;
  }

  async startOperation(request, snapshot, privateState, {
    kind,
    status,
    input = {},
    cancellable = true,
  }) {
    const projectId = privateState.binding.projectId ?? snapshot.project?.id;
    const handle = await this.operations.begin({
      projectId,
      runId: request.runId,
      kind,
      cancellable,
      metadata: {
        actionIntentId: request.intent.actionIntentId,
        actionId: request.actionId,
      },
    });
    this.pendingHandles.set(handle.operationId, handle);
    snapshot.operation = {
      id: handle.operationId,
      operationId: handle.operationId,
      kind,
      settlement: 'active',
      phase: kind,
      cancellable,
    };
    const next = transition(snapshot, { status, attention: null });
    return {
      snapshot: next,
      privateState,
      result: {
        operationId: handle.operationId,
        launch: {
          token: this.createOperationId(),
          kind,
          operationId: handle.operationId,
          runId: request.runId,
          input,
        },
      },
      evidence: { operationId: handle.operationId, durableStart: true },
    };
  }

  async rollback(request, snapshot, privateState) {
    if (snapshot.rollback?.pending) {
      return this.startOperation(request, snapshot, privateState, {
        kind: 'rollback',
        status: 'applying',
        cancellable: false,
      });
    }
    const inspection = await inspectExecutableRollback({
      runId: request.runId,
      projectPath: privateState.binding.projectPath,
      executable: privateState,
    });
    if (!inspection.available) {
      throw actionError(
        inspection.reason || 'The run backup cannot be safely restored.',
        'ACTION_NOT_AVAILABLE',
        409,
      );
    }
    snapshot.rollback = {
      pending: true,
      backupAvailable: true,
      warnings: [{
        code: 'rollback-project-write',
        message: `${inspection.manifest.items.length} project paths will be restored.`,
      }],
    };
    return immediate(transition(snapshot, {
      status: snapshot.run.status,
      attention: 'rollback',
    }), privateState);
  }

  async cancel(snapshot, privateState) {
    const operationId = snapshot.operation?.id ?? snapshot.operation?.operationId;
    if (!operationId) throw actionError('There is no active operation to cancel.', 'ACTION_NOT_AVAILABLE', 409);
    const cancelled = await this.operations.requestCancellation(operationId);
    snapshot.operation = {
      ...snapshot.operation,
      ...cancelled.operation,
      id: operationId,
    };
    return immediate(snapshot, privateState, { operation: cancelled.operation });
  }

  retry(request, snapshot, privateState) {
    const retryKind = snapshot.error?.retryKind;
    if (snapshot.error?.retryable !== true || !['archive_root', 'checks'].includes(retryKind)) {
      throw actionError('The failed operation cannot be retried safely.', 'ACTION_NOT_AVAILABLE', 409);
    }
    return this.startOperation(request, snapshot, privateState, {
      kind: retryKind,
      status: retryKind === 'checks' ? 'checking' : 'inspecting',
    });
  }
}

function acknowledgeSafety(snapshot, privateState) {
  if (!privateState.safety) {
    throw actionError('Archive safety findings are not available.', 'ACTION_NOT_AVAILABLE', 409);
  }
  privateState.safety.acknowledged = true;
  snapshot.archiveSafety = {
    ...(snapshot.archiveSafety ?? {}),
    acknowledged: true,
  };
  const attention = unresolved(privateState) ? 'conflicts' : 'plan';
  return immediate(transition(snapshot, { status: 'waiting_action', attention }), privateState);
}

function decidePath(snapshot, privateState, filePath, decision) {
  const nextPrivate = updateExecutableDecision(privateState, filePath, decision);
  snapshot.plan = publicPlanFromExecutable(nextPrivate);
  const attention = snapshot.plan.unresolvedConflicts ? 'conflicts' : 'plan';
  return immediate(transition(snapshot, { status: 'waiting_action', attention }), nextPrivate);
}

function continueAfterCommit(snapshot, privateState) {
  const attention = nextPostCommitAttention(privateState.workflow);
  return immediate(transition(snapshot, {
    status: attention ? 'waiting_action' : 'completed',
    attention,
  }), privateState);
}

function immediate(snapshot, privateState, result = null) {
  return { snapshot, privateState, result, evidence: null };
}

function transition(snapshot, { status, attention }) {
  return {
    ...snapshot,
    run: {
      ...snapshot.run,
      status,
      attention,
    },
    operation: ['applying', 'checking', 'committing', 'deploying', 'inspecting'].includes(status)
      ? snapshot.operation
      : null,
    error: null,
  };
}

function unresolved(privateState) {
  return (privateState.decisions ?? []).some((item) => item.decision === null);
}

function assertPlanReady(privateState) {
  if (!privateState.plan) throw actionError('The run has no executable plan.', 'ACTION_NOT_AVAILABLE', 409);
  if (unresolved(privateState)) {
    throw actionError('Every conflict must be resolved before apply.', 'ACTION_NOT_AVAILABLE', 409);
  }
  if (privateState.safety?.warnings?.length && privateState.safety.acknowledged !== true) {
    throw actionError('Archive safety findings must be acknowledged before apply.', 'ACTION_NOT_AVAILABLE', 409);
  }
}

function assertDeployment(workflow) {
  if (!deploymentAvailable(workflow)) {
    throw actionError('Deployment is not configured for this workflow.', 'ACTION_NOT_AVAILABLE', 409);
  }
}

function assertRunBinding(runId, snapshot, privateState) {
  if (
    snapshot.run?.id !== runId
    || privateState?.version !== 1
    || privateState.binding?.runId !== runId
    || !privateState.binding?.projectPath
  ) {
    throw actionError('Run execution binding is invalid.', 'INTERNAL_ERROR', 500);
  }
}

function actionError(message, code, status) {
  return Object.assign(new Error(message), {
    code,
    status,
    expose: status < 500,
    detail: message,
  });
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}
