import { getGitStatus, runGit } from './repository.js';

export async function buildDirtyTreeChangeSet(projectPath, { signal = null } = {}) {
  const status = await getGitStatus(projectPath, { signal });
  const entries = status.entries.filter((item) => item.status !== '??');
  const plan = emptyPlan();
  for (const entry of entries) {
    const item = { path: entry.path, kind: classifyEntry(entry) };
    plan[item.kind].push(item);
  }
  plan.counts = {
    created: plan.created.length,
    updated: plan.updated.length,
    deleted: plan.deleted.length,
  };
  if (!entries.length) return { status, entries, plan, patchContent: '' };
  const head = await runGit(projectPath, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true, signal });
  const diffArgs = head.ok
    ? ['diff', '--binary', '--no-ext-diff', 'HEAD', '--']
    : ['diff', '--binary', '--no-ext-diff', '--cached', '--'];
  const diff = await runGit(projectPath, diffArgs, { allowFailure: true, signal });
  return { status, entries, plan, patchContent: diff.stdout || '' };
}

function emptyPlan() {
  return { created: [], updated: [], deleted: [], conflicts: [], preserved: [], unchanged: [], skipped: [], counts: { created: 0, updated: 0, deleted: 0 } };
}

function classifyEntry(entry) {
  const status = `${entry.indexStatus ?? ''}${entry.worktreeStatus ?? ''}`;
  if (status.includes('D')) return 'deleted';
  if (status.includes('A')) return 'created';
  return 'updated';
}
