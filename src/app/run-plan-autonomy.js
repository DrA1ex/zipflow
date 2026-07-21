import { createCheckpointRef, getGitStatus } from '../git/repository.js';
import { loadPlanItemDiff, unifiedDiffLines } from '../diff/file.js';
import { hashText } from '../utils/hash.js';
import { saveRunRecord } from '../runs/store.js';
import { decideAtGate, autonomyEnabledFor, markAutonomyDecision } from './autonomy-flow.js';
import { archiveConflictPaths } from './run-review.js';

export function serializePlanForDecision(plan) {
  return {
    counts: plan.counts,
    created: plan.created.map((item) => item.path),
    updated: plan.updated.map((item) => item.path),
    deleted: plan.deleted.map((item) => item.path),
    preserved: plan.preserved.map((item) => ({ path: item.path, reason: item.reason })),
    unchanged: plan.unchanged.map((item) => item.path),
    conflicts: plan.conflicts.map((item) => ({ path: item.path, reason: item.reason })),
  };
}

export async function handleLocalWorkAutonomy(controller) {
  const { state } = controller;
  if (!state.project.git || state.workflow.autonomy?.mode === 'manual') return true;
  const status = await getGitStatus(state.project.root).catch(() => null);
  if (!status) return state.workflow.autonomy.mode === 'guarded' ? false : true;
  if (status.conflicted.length) {
    controller.message('Autopilot paused for Git conflicts', [
      'The repository already contains unresolved merge conflicts. Zipflow will not continue autonomously.',
    ], 'warning');
    return false;
  }
  const changed = new Set([...state.plan.created, ...state.plan.updated, ...state.plan.deleted].map((item) => item.path));
  const stagedOverlap = status.staged.filter((item) => changed.has(item.path));
  if (stagedOverlap.length || (state.workflow.autonomy.mode === 'guarded' && status.staged.length)) {
    controller.message('Autopilot paused for staged changes', [
      stagedOverlap.length
        ? `${stagedOverlap.length} staged path${stagedOverlap.length === 1 ? '' : 's'} overlap the update plan.`
        : `${status.staged.length} user-staged path${status.staged.length === 1 ? '' : 's'} must remain under manual control in Guarded autopilot.`,
      "Zipflow will not alter or commit across the user's staged index automatically.",
    ], 'warning');
    return false;
  }
  const dirty = [...status.staged, ...status.unstaged];
  if (!dirty.length) return true;
  const decision = await decideAtGate(controller, {
    gate: 'local-work', capability: 'decidePlanApplication',
    allowedActions: ['continue', 'create-checkpoint', 'ask-user', 'abort'],
    fallback: 'ask-user', label: 'Autopilot is reviewing local work',
    context: {
      state: { gitStatus: serializeGitStatus(status), planPaths: [...changed] },
      riskLevel: status.staged.length ? 'high' : dirty.some((item) => changed.has(item.path)) ? 'high' : 'medium',
      complete: true,
    },
    validateDecision: gitStateValidator(state.project.root, status),
  });
  if (decision.action === 'abort') {
    await markAutonomyDecision(controller, decision, 'executing');
    await markAutonomyDecision(controller, decision, 'executed', { result: 'run-cancelled' });
    return 'cancelled';
  }
  if (decision.action === 'create-checkpoint') {
    await markAutonomyDecision(controller, decision, 'executing');
    const checkpoint = await createAutonomyCheckpoint(controller, status);
    await markAutonomyDecision(controller, decision, checkpoint ? 'executed' : 'failed', { result: checkpoint ? 'checkpoint-created' : 'checkpoint-failed' });
    return checkpoint ? true : false;
  }
  if (decision.action === 'continue') {
    await markAutonomyDecision(controller, decision, 'executed', { result: 'continued-with-local-work' });
    return true;
  }
  return false;
}

export async function resolveConflictsAutonomously(controller) {
  const { state } = controller;
  if (!state.plan.conflicts.length) return true;
  if (!autonomyEnabledFor(state, 'decideConflicts')) return false;
  for (const conflict of state.plan.conflicts) {
    if (state.decisions.get(conflict.path)) continue;
    const diff = await loadPlanItemDiff(conflict);
    const diffText = unifiedDiffLines(diff).map((line) => typeof line === 'string' ? line : line.text).join('\n').slice(0, 30_000);
    const decision = await decideAtGate(controller, {
      gate: 'file-conflict', capability: 'decideConflicts',
      allowedActions: ['use-archive', 'keep-local', 'ask-user', 'abort'],
      fallback: 'ask-user', label: `Autopilot is resolving ${conflict.path}`,
      context: {
        state: { path: conflict.path, kind: conflict.kind, reason: conflict.reason, gitStatus: conflict.gitStatus, diff: diffText },
        riskLevel: 'high', complete: !diff.binary,
      },
    });
    if (decision.action === 'abort') {
      await markAutonomyDecision(controller, decision, 'executing');
      await markAutonomyDecision(controller, decision, 'executed', { result: `cancelled-at:${conflict.path}` });
      return 'cancelled';
    }
    if (decision.action === 'ask-user') return false;
    const resolution = decision.action === 'use-archive' ? 'archive' : 'keep';
    await markAutonomyDecision(controller, decision, 'executing');
    state.decisions.set(conflict.path, resolution);
    await markAutonomyDecision(controller, decision, 'executed', { result: { path: conflict.path, resolution } });
  }
  controller.message('Autopilot resolved conflicts', [
    `${archiveConflictPaths(state).length} archive versions · ${state.plan.conflicts.length - archiveConflictPaths(state).length} local versions`,
  ], 'choice');
  return true;
}

export function gitStateValidator(projectRoot, beforeStatus) {
  const beforeHash = hashText(JSON.stringify(serializeGitStatus(beforeStatus)));
  return async () => {
    const afterStatus = await getGitStatus(projectRoot).catch(() => null);
    const afterHash = hashText(JSON.stringify(serializeGitStatus(afterStatus)));
    return { ok: beforeHash === afterHash, stateHash: afterHash };
  };
}

export function serializeGitStatus(status) {
  if (!status) return null;
  return {
    staged: status.staged.map((item) => ({ path: item.path, status: item.status })),
    unstaged: status.unstaged.map((item) => ({ path: item.path, status: item.status })),
    conflicted: status.conflicted.map((item) => ({ path: item.path, status: item.status })),
  };
}

async function createAutonomyCheckpoint(controller, status) {
  const { state } = controller;
  const operation = controller.beginOperation({ kind: 'git-checkpoint', label: 'Creating Git checkpoint' });
  try {
    const checkpoint = await createCheckpointRef(state.project.root, state.run.id, { signal: operation.signal });
    if (!checkpoint.ok) throw new Error(checkpoint.reason);
    state.run.checkpoint = {
      revision: checkpoint.revision,
      ref: checkpoint.ref,
      paths: checkpoint.paths ?? [],
      backupOnlyPaths: checkpoint.untrackedPaths ?? [],
      preservesIndex: true,
      autonomous: true,
    };
    state.run = await saveRunRecord(state.run);
    controller.message('Checkpoint created', [
      checkpoint.ref ? `${checkpoint.revision} · ${checkpoint.ref}` : 'No tracked local changes required a Git checkpoint.',
      'The working tree and user index were not modified; untracked files remain protected by the normal file backup.',
    ], 'success');
    return true;
  } catch (error) {
    if (error.code === 'cancelled') {
      controller.message('Checkpoint cancelled', ['Autopilot returned control without changing Git state.'], 'warning');
      return false;
    }
    controller.message('Checkpoint unavailable', [error.message], 'warning');
    return false;
  } finally {
    operation.finish();
  }
}
