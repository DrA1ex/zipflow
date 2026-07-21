export const RUN_TYPE_FILTERS = Object.freeze(['all', 'update', 'test', 'deploy']);
export const RUN_STATUS_FILTERS = Object.freeze(['all', 'successful', 'failed', 'rolled-back']);

export function runType(run) {
  if (run?.kind === 'manual-checks') return 'test';
  if (run?.kind === 'manual-deploy') return 'deploy';
  return 'update';
}

export function runTypeLabel(value) {
  return ({ all: 'All types', update: 'Archive updates', test: 'Manual tests', deploy: 'Manual deployments' })[value] ?? 'All types';
}

export function runTypeTag(run) {
  const base = ({ update: 'UPDATE', test: 'TEST', deploy: 'DEPLOY' })[runType(run)];
  if (runType(run) !== 'update') return base;
  const mode = run?.autonomy?.mode;
  if (mode === 'guarded') return `${base} · GUARDED`;
  if (mode === 'full') return `${base} · FULL`;
  return base;
}

export function runTypeDescription(run) {
  const type = runType(run);
  if (type === 'test') return 'Manual tests against the current project. No archive was applied, so this run has no file diff or rollback.';
  if (type === 'deploy') return 'Manual deployment of the current project. No archive was applied, so this run has no file diff or rollback.';
  return 'Archive update with a deterministic file plan, stored patch, checks, and optional rollback.';
}

export function matchesRunType(run, filter = 'all') {
  return filter === 'all' || runType(run) === filter;
}

export function matchesRunStatus(run, filter = 'all') {
  if (filter === 'successful') return ['completed', 'checks_passed', 'no_changes'].includes(run?.status);
  if (filter === 'failed') return ['failed', 'checks_failed', 'completed_with_errors', 'interrupted', 'interrupted_closed', 'checks_cancelled'].includes(run?.status) || run?.deploy?.ok === false;
  if (filter === 'rolled-back') return run?.status === 'rolled_back' || run?.rollback?.status === 'completed';
  return true;
}

export function runStatusFilterLabel(value) {
  return ({ all: 'All results', successful: 'Successful', failed: 'Failed', 'rolled-back': 'Rolled back' })[value] ?? 'All results';
}

export function runTypeFilterDescription(value) {
  return ({
    all: 'Show archive updates, manual tests, and manual deployments.',
    update: 'Show only runs that inspected or applied a source ZIP.',
    test: 'Show only checks started manually against the current project.',
    deploy: 'Show only deployments started manually against the current project.',
  })[value] ?? '';
}

export function runStatusFilterDescription(value) {
  return ({
    all: 'Show every result state.',
    successful: 'Completed runs without required failures.',
    failed: 'Failed runs, failed checks, and completed runs with errors.',
    'rolled-back': 'Archive updates whose applied files were restored.',
  })[value] ?? '';
}
