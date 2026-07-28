import { SURFACE_KINDS } from '../protocol/constants.js';
import { inferSurfaceKind } from './surface-projector.js';

const SURFACE_KIND_SET = new Set(SURFACE_KINDS);

export const ATTENTION_SURFACE_KINDS = Object.freeze({
  project: 'project_home',
  workflow: 'workflow_setup',
  archive_root: 'archive_root_choice',
  archive_safety: 'archive_safety',
  plan: 'plan_review',
  plan_files: 'plan_files',
  conflicts: 'conflict_summary',
  conflict: 'conflict_file',
  checks_failed: 'checks_failed',
  commit: 'commit_choice',
  commit_message: 'commit_message',
  deploy: 'deploy_choice',
  history: 'history',
  run_details: 'run_details',
  rollback: 'rollback_confirm',
  error: 'error',
});

export const RUN_STATUS_SURFACE_KINDS = Object.freeze({
  created: 'project_home',
  inspecting: 'archive_inspecting',
  applying: 'operation_progress',
  checking: 'operation_progress',
  committing: 'operation_progress',
  deploying: 'operation_progress',
  completed: 'completed',
  cancelled: 'completed',
  rolled_back: 'completed',
  failed: 'error',
  uncertain: 'error',
});

export function resolveWorkflowSurfaceKind(snapshot = {}, { actionState = null } = {}) {
  if (actionState === 'active') return 'operation_progress';
  if (actionState === 'uncertain') return 'error';

  const status = snapshot.run?.status ?? snapshot.runStatus ?? null;
  const attention = snapshot.run?.attention ?? snapshot.attention ?? null;
  if (snapshot.error || status === 'uncertain') return 'error';
  if (snapshot.rollback?.pending || attention === 'rollback') return 'rollback_confirm';
  if (snapshot.history?.selectedRun || snapshot.historyRun || attention === 'run_details') return 'run_details';
  if (snapshot.history?.open || snapshot.view === 'history' || attention === 'history') return 'history';
  if (snapshot.checks?.status === 'failed' || attention === 'checks_failed') return 'checks_failed';
  if (RUN_STATUS_SURFACE_KINDS[status]) return RUN_STATUS_SURFACE_KINDS[status];
  if (SURFACE_KIND_SET.has(attention)) return attention;
  if (ATTENTION_SURFACE_KINDS[attention]) return ATTENTION_SURFACE_KINDS[attention];
  if (snapshot.workflow?.configured === false || snapshot.view === 'workflow_setup') return 'workflow_setup';
  return inferSurfaceKind({ ...snapshot, surfaceKind: undefined });
}

