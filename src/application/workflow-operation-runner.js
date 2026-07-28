import { discoverProject as discoverProjectDefault } from '../project/detect.js';
import { loadRunRecord, saveRunRecord } from '../runs/store.js';
import {
  inspectUploadedArchive,
  selectArchiveRootAndPlan,
} from './archive-runner.js';
import {
  applyExecutablePlan,
  rollbackExecutableRun,
} from './project-mutation-runner.js';
import {
  commitAppliedRun,
  nextPostCommitAttention,
  runConfiguredChecks,
  runConfiguredDeployment,
} from './post-apply-runner.js';
import {
  archiveOutcome,
  assertPublicSnapshot,
  cleanOutput,
  clone,
  finiteCount,
  minimalLegacy,
  operationOutcome,
  postCheckOutcome,
  publicApplied,
  publicChecks,
  publicCommit,
  publicDeployment,
  publicError,
  requireWorkflow,
  runnerError,
  safeTimestamp,
  selectedChecks,
  snapshotBase,
  transitionSnapshot,
  withRevision,
} from './workflow-operation-state.js';

const KINDS = new Set([
  'archive_inspection', 'archive_root', 'apply', 'checks', 'commit', 'deploy', 'rollback',
]);

export class WorkflowOperationRunner {
  constructor({
    sessions,
    journal = null,
    discoverProject = discoverProjectDefault,
    loadLegacyRun = loadRunRecord,
    saveLegacyRun = saveRunRecord,
    inspectArchive = inspectUploadedArchive,
    selectArchiveRoot = selectArchiveRootAndPlan,
    applyPlan = applyExecutablePlan,
    runChecks = runConfiguredChecks,
    commitRun = commitAppliedRun,
    deployRun = runConfiguredDeployment,
    rollbackRun = rollbackExecutableRun,
  } = {}) {
    if (!sessions?.get || !sessions?.update || !sessions?.appendOutput) {
      throw new TypeError('Workflow operation runner requires a run session store.');
    }
    if (journal && typeof journal.append !== 'function') {
      throw new TypeError('Workflow operation runner journal is invalid.');
    }
    Object.assign(this, {
      sessions, journal, discoverProject, loadLegacyRun, saveLegacyRun,
      inspectArchive, selectArchiveRoot, applyPlan, runChecks, commitRun, deployRun, rollbackRun,
    });
  }

  async run({ handle, launch } = {}) {
    assertLaunch(handle, launch);
    let session = await this.sessions.get(launch.runId);
    if (!session) throw runnerError('Run was not found.', 'RUN_NOT_FOUND', 404);
    assertOperationBinding(session, handle, launch);

    const legacy = await this.loadLegacyRun(launch.runId);
    const privateState = clone(session.executionManifest);
    const project = await this.discoverProject(session.binding.projectPath);
    const context = { handle, launch, session, legacy, privateState, project };

    let outcome;
    try {
      outcome = await this.execute(context);
    } catch (error) {
      return this.fail(context, error);
    }

    session = await this.requireCurrentSession(launch.runId);
    for (const output of outcome.outputs ?? []) {
      session = await this.appendOutput(session, output);
    }
    const revision = session.revision + 1;
    const snapshot = withRevision(outcome.snapshot, revision);
    assertPublicSnapshot(snapshot);
    await this.persistLegacy(context, outcome.legacy);
    const finalSession = await this.sessions.update({
      runId: launch.runId,
      expectedRevision: session.revision,
      changes: {
        status: outcome.status,
        operationId: null,
        executionManifest: outcome.privateState,
        publicSummary: snapshot,
      },
    });
    await handle.settle('succeeded');
    await this.emitFinal(finalSession, handle.operationId);
    return finalSession;
  }

  execute(context) {
    switch (context.launch.kind) {
      case 'archive_inspection': return this.inspect(context);
      case 'archive_root': return this.chooseRoot(context);
      case 'apply': return this.apply(context);
      case 'checks': return this.check(context);
      case 'commit': return this.commit(context);
      case 'deploy': return this.deploy(context);
      case 'rollback': return this.rollback(context);
      default: throw new TypeError('Unsupported workflow operation.');
    }
  }

  async inspect(context) {
    const { session, privateState, project, handle } = context;
    const result = await this.inspectArchive({
      runId: session.run.runId,
      project: { ...project, projectId: session.binding.projectId },
      workflow: requireWorkflow(privateState),
      workflowRevision: session.binding.workflowRevision,
      blob: privateState?.binding?.blob ?? privateState?.blob,
      signal: handle.signal,
    });
    return archiveOutcome(context, result);
  }

  async chooseRoot(context) {
    const { session, privateState, project, handle, launch } = context;
    const result = await this.selectArchiveRoot({
      runId: session.run.runId,
      project: { ...project, projectId: session.binding.projectId },
      workflow: requireWorkflow(privateState),
      executable: privateState,
      rootId: launch.input.rootId,
      signal: handle.signal,
    });
    return archiveOutcome(context, result);
  }

  async apply(context) {
    const { session, privateState, handle } = context;
    const workflow = requireWorkflow(privateState);
    let applied;
    await handle.enterCritical('apply');
    try {
      applied = await this.applyPlan({
        runId: session.run.runId,
        projectPath: session.binding.projectPath,
        executable: privateState,
        managedHistoryEnabled: privateState.settings?.managedHistoryPolicy !== 'disabled',
        signal: handle.signal,
        shouldCancel: () => handle.signal?.aborted === true,
      });
    } finally {
      await handle.leaveCritical('apply');
    }
    const nextPrivate = {
      ...privateState,
      applied: clone(applied.applied),
      managedHistory: clone(applied.managedHistory),
      transaction: clone(applied.transaction),
    };
    const legacyChanges = {
      applied: clone(applied.applied), managedHistory: clone(applied.managedHistory), status: 'applied',
    };
    const base = transitionSnapshot(context, nextPrivate, {
      applied: publicApplied(applied.applied),
    });
    context.privateState = nextPrivate;
    context.partialLegacy = legacyChanges;
    context.partialSnapshot = base;
    if (handle.signal?.aborted) throw cancelledError();
    if (!selectedChecks(workflow).length) {
      return postCheckOutcome(context, nextPrivate, base, legacyChanges, { ok: true }, []);
    }
    const checked = await this.executeChecks(context, nextPrivate, null);
    return postCheckOutcome(
      context,
      { ...nextPrivate, checks: clone(checked.checks) },
      { ...base, checks: publicChecks(checked.checks) },
      { ...legacyChanges, checks: clone(checked.checks) },
      checked.checks,
      checked.output ? [{ source: 'checks', text: checked.output }] : [],
    );
  }

  async check(context) {
    const checked = await this.executeChecks(context, context.privateState, context.launch.input.checkIds);
    const nextPrivate = { ...context.privateState, checks: clone(checked.checks) };
    const snapshot = transitionSnapshot(context, nextPrivate, { checks: publicChecks(checked.checks) });
    const outputs = checked.output ? [{ source: 'checks', text: checked.output }] : [];
    if (context.session.run.kind === 'checks') {
      const ok = checked.checks?.ok === true;
      return operationOutcome({
        status: ok ? 'completed' : 'waiting_action',
        attention: ok ? null : 'checks_failed',
        snapshot,
        privateState: nextPrivate,
        legacy: { checks: clone(checked.checks), status: ok ? 'completed' : 'checks_failed' },
        outputs,
      });
    }
    return postCheckOutcome(
      context, nextPrivate, snapshot,
      { checks: clone(checked.checks) }, checked.checks, outputs,
    );
  }

  async executeChecks(context, privateState, checkIds) {
    const result = await this.runChecks({
      workflow: requireWorkflow(privateState),
      projectPath: context.session.binding.projectPath,
      changedPaths: privateState.applied?.changedPaths ?? [],
      checkIds: checkIds ?? privateState.selectedCheckIds ?? null,
      settings: privateState.settings ?? null,
      signal: context.handle.signal,
    });
    return { checks: result?.checks ?? result, output: String(result?.output ?? '') };
  }

  async commit(context) {
    const { session, privateState, handle, launch } = context;
    const committed = await this.commitRun({
      workflow: requireWorkflow(privateState),
      projectPath: session.binding.projectPath,
      appliedPaths: privateState.applied?.paths ?? context.legacy?.applied?.paths ?? [],
      message: launch.input.message,
      signal: handle.signal,
    });
    const nextPrivate = { ...privateState, commit: clone(committed) };
    const attention = nextPostCommitAttention(privateState.workflow);
    return operationOutcome({
      status: attention ? 'waiting_action' : 'completed', attention,
      snapshot: transitionSnapshot(context, nextPrivate, { commit: publicCommit(committed) }),
      privateState: nextPrivate,
      legacy: { commit: clone(committed), status: attention ? 'committed' : 'completed' },
    });
  }

  async deploy(context) {
    const progress = [];
    const deployed = await this.deployRun({
      workflow: requireWorkflow(context.privateState),
      projectPath: context.session.binding.projectPath,
      settings: context.privateState.settings ?? null,
      signal: context.handle.signal,
      onProgress: (event) => {
        if (event?.output) progress.push(event.output);
      },
    });
    const nextPrivate = { ...context.privateState, deploy: clone(deployed) };
    const ok = deployed?.ok === true;
    const text = [progress.join(''), deployed?.stdout, deployed?.stderr].filter(Boolean).join('\n');
    return operationOutcome({
      status: ok ? 'completed' : 'waiting_action', attention: ok ? null : 'deploy',
      snapshot: transitionSnapshot(context, nextPrivate, {
        deployment: publicDeployment(deployed, context.privateState.workflow),
      }),
      privateState: nextPrivate,
      legacy: { deploy: clone(deployed), status: ok ? 'completed' : 'deploy_failed' },
      outputs: text ? [{ source: 'deploy', text }] : [],
    });
  }

  async rollback(context) {
    const rolledBack = await this.rollbackRun({
      runId: context.session.run.runId,
      projectPath: context.session.binding.projectPath,
      executable: context.privateState,
      managedHistory: context.privateState.managedHistory ?? context.legacy?.managedHistory ?? null,
      signal: context.handle.signal,
    });
    const nextPrivate = { ...context.privateState, rollback: clone(rolledBack) };
    return operationOutcome({
      status: 'rolled_back', attention: null,
      snapshot: transitionSnapshot(context, nextPrivate, {
        rollback: {
          status: 'completed', restored: finiteCount(rolledBack?.restored),
          at: safeTimestamp(rolledBack?.at), backupAvailable: false,
        },
      }),
      privateState: nextPrivate,
      legacy: { rollback: clone(rolledBack), status: 'rolled_back' },
    });
  }

  async appendOutput(session, output) {
    const text = cleanOutput(output.text);
    if (!text) return session;
    return this.sessions.appendOutput({
      runId: session.run.runId,
      expectedRevision: session.revision,
      source: output.source,
      stream: 'event',
      text,
      truncated: String(output.text ?? '').length > text.length,
      omittedBytes: Math.max(0, Buffer.byteLength(String(output.text ?? '')) - Buffer.byteLength(text)),
    });
  }

  async persistLegacy(context, changes) {
    const current = context.legacy ?? minimalLegacy(context);
    await this.saveLegacyRun({ ...current, ...clone(changes), error: null });
  }

  async fail(context, error) {
    context.session = await this.requireCurrentSession(context.launch.runId);
    const cancelled = isCancelled(error, context.handle);
    const status = cancelled ? 'cancelled' : 'failed';
    const safeError = cancelled ? null : publicError(error, context.launch.kind);
    const base = context.partialSnapshot ?? snapshotBase(context);
    const snapshot = withRevision({
      ...base,
      run: { ...base.run, status, attention: null },
      operation: null,
      error: safeError,
    }, context.session.revision + 1);
    assertPublicSnapshot(snapshot);
    await this.persistLegacy(context, {
      ...context.partialLegacy,
      status,
      error: safeError ? { code: safeError.code, message: safeError.message } : null,
    });
    const finalSession = await this.sessions.update({
      runId: context.launch.runId,
      expectedRevision: context.session.revision,
      changes: {
        status,
        operationId: null,
        executionManifest: context.privateState,
        publicSummary: snapshot,
      },
    });
    await context.handle.settle(cancelled ? 'cancelled' : 'failed', {
      error: safeError ?? undefined,
    });
    await this.emitFinal(finalSession, context.handle.operationId);
    throw error;
  }

  async requireCurrentSession(runId) {
    const session = await this.sessions.get(runId);
    if (!session) throw runnerError('Run was not found.', 'RUN_NOT_FOUND', 404);
    return session;
  }

  async emitFinal(session, operationId) {
    if (!this.journal) return;
    const fields = {
      projectId: session.binding.projectId,
      runId: session.run.runId,
      operationId,
      revision: session.revision,
    };
    const status = session.run.status;
    const attention = session.publicSummary.run?.attention ?? null;
    await this.journal.append('surface.changed', {
      ...fields, data: { status, attention },
    });
    const type = status === 'waiting_action' ? 'run.attention'
      : status === 'rolled_back' ? 'run.rolled_back'
        : status === 'completed' ? 'run.completed'
          : ['failed', 'cancelled'].includes(status) ? 'run.failed' : null;
    if (type) await this.journal.append(type, {
      ...fields, data: { status, attention, cancelled: status === 'cancelled' },
    });
  }
}

function assertLaunch(handle, launch) {
  if (!handle?.operationId || !handle?.settle || !handle?.enterCritical || !handle?.leaveCritical) {
    throw new TypeError('A durable operation handle is required.');
  }
  if (!launch?.runId || !KINDS.has(launch.kind) || !launch.input || typeof launch.input !== 'object' || Array.isArray(launch.input)) {
    throw new TypeError('Workflow operation launch is invalid.');
  }
}

function assertOperationBinding(session, handle, launch) {
  if (session.run.runId !== launch.runId || session.run.operationId !== handle.operationId) {
    throw runnerError('Operation does not match the durable run.', 'OPERATION_CONFLICT', 409);
  }
}

function isCancelled(error, handle) {
  return handle.signal?.aborted === true
    || ['cancelled', 'OPERATION_CANCELLED'].includes(error?.code)
    || error?.name === 'AbortError';
}

function cancelledError() {
  return Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' });
}
