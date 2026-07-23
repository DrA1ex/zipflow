import path from 'node:path';
import { runProcess } from '../utils/process.js';
import { isProtectedProjectPath } from '../archive/protected.js';
import { findGitRoot } from './root.js';
export { findGitRoot } from './root.js';


export async function initializeRepository(projectPath) {
  const result = await runGit(projectPath, ['init'], { allowFailure: true });
  if (!result.ok) return { ok: false, reason: result.stderr.trim() || result.stdout.trim() || 'git init failed' };
  const root = await findGitRoot(projectPath);
  return { ok: Boolean(root), root, output: result.stdout.trim() };
}

export async function getGitStatus(projectPath) {
  const result = await runGit(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = parsePorcelain(result.stdout);
  return {
    entries,
    byPath: new Map(entries.map((entry) => [entry.path, entry])),
    staged: entries.filter((entry) => entry.indexStatus !== ' ' && entry.indexStatus !== '?'),
    unstaged: entries.filter((entry) => entry.worktreeStatus !== ' '),
    conflicted: entries.filter((entry) => isConflictStatus(entry.status)),
  };
}

export async function listTrackedFiles(projectPath) {
  const result = await runGit(projectPath, ['ls-files', '-z']);
  return splitNullPaths(result.stdout);
}

export async function listIgnoredPaths(projectPath, paths, { includeTracked = false } = {}) {
  if (!paths.length) return new Set();
  const args = ['check-ignore', '-z', '--stdin'];
  if (includeTracked) args.splice(1, 0, '--no-index');
  const result = await runGit(projectPath, args, {
    allowFailure: true,
    input: `${paths.join('\0')}\0`,
  });
  if (!result.ok && result.code !== 1) {
    const reason = result.stderr.trim() || result.stdout.trim();
    if (reason) throw new Error(reason);
  }
  return new Set(splitNullPaths(result.stdout));
}

export async function createInitialCommit(projectPath, message = 'Initial commit') {
  const status = await getGitStatus(projectPath);
  if (status.staged.length) return { ok: false, reason: 'The Git index already contains staged changes.' };
  const add = await runGit(projectPath, ['add', '--all'], { allowFailure: true });
  if (!add.ok) return { ok: false, reason: add.stderr.trim() || add.stdout.trim() || 'git add failed' };
  const staged = await runGit(projectPath, ['diff', '--cached', '--name-only', '-z'], { allowFailure: true });
  const paths = splitNullPaths(staged.stdout);
  if (!paths.length) return { ok: false, reason: 'There are no files available for the first commit.' };
  const commit = await runGit(projectPath, ['commit', '-m', message], { allowFailure: true });
  if (!commit.ok) {
    await runGit(projectPath, ['reset', '-q'], { allowFailure: true });
    return { ok: false, reason: commit.stderr.trim() || commit.stdout.trim() || 'git commit failed' };
  }
  const revision = await runGit(projectPath, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, revision: revision.stdout.trim(), paths, output: commit.stdout.trim() };
}

export async function createCommit(projectPath, paths, message, { signal = null } = {}) {
  const status = await getGitStatus(projectPath);
  if (status.staged.length) {
    return { ok: false, reason: 'The Git index already contains staged changes.' };
  }
  const requestedPaths = [...new Set(paths)].filter(Boolean);
  const safePaths = requestedPaths.filter((item) => !isProtectedProjectPath(item));
  const ignored = await listIgnoredPaths(projectPath, safePaths);
  const uniquePaths = safePaths.filter((item) => !ignored.has(normalizeGitPath(item)));
  if (!uniquePaths.length) {
    return { ok: false, reason: 'There are no committable applied paths. Protected and untracked ignored files are excluded automatically.' };
  }
  for (const chunk of chunks(uniquePaths, 100)) {
    const add = await runGit(projectPath, ['add', '--all', '--', ...chunk], { allowFailure: true, signal });
    if (!add.ok) {
      await unstagePaths(projectPath, uniquePaths, { signal });
      return { ok: false, reason: add.stderr || add.stdout || 'git add failed' };
    }
  }
  const commit = await runGit(projectPath, ['commit', '-m', message], { allowFailure: true, signal });
  if (!commit.ok) {
    await unstagePaths(projectPath, uniquePaths, { signal });
    return { ok: false, reason: commit.stderr || commit.stdout || 'git commit failed' };
  }
  const revision = await runGit(projectPath, ['rev-parse', '--short', 'HEAD'], { signal });
  return { ok: true, revision: revision.stdout.trim(), output: commit.stdout.trim(), paths: uniquePaths, omittedPaths: requestedPaths.filter((item) => !uniquePaths.includes(item)) };
}


export async function createCheckpointRef(projectPath, runId, { signal = null } = {}) {
  const status = await getGitStatus(projectPath);
  const trackedEntries = status.entries.filter((item) => item.status !== '??');
  const untrackedPaths = status.entries.filter((item) => item.status === '??').map((item) => item.path);
  if (!trackedEntries.length) {
    return { ok: true, revision: null, ref: null, empty: true, paths: [], untrackedPaths };
  }
  const created = await runGit(projectPath, ['stash', 'create', `zipflow checkpoint ${runId}`], { allowFailure: true, signal });
  if (!created.ok) return { ok: false, reason: created.stderr.trim() || created.stdout.trim() || 'git stash create failed' };
  const revision = created.stdout.trim();
  if (!revision) return { ok: true, revision: null, ref: null, empty: true, paths: [], untrackedPaths };
  const ref = `refs/zipflow/checkpoints/${runId}`;
  const updated = await runGit(projectPath, ['update-ref', ref, revision], { allowFailure: true, signal });
  if (!updated.ok) return { ok: false, reason: updated.stderr.trim() || updated.stdout.trim() || 'git update-ref failed' };
  return {
    ok: true, revision: revision.slice(0, 12), fullRevision: revision, ref,
    paths: trackedEntries.map((item) => item.path), untrackedPaths,
  };
}

export async function currentRevision(projectPath) {
  const result = await runGit(projectPath, ['rev-parse', '--short', 'HEAD'], { allowFailure: true });
  return result.ok ? result.stdout.trim() : null;
}

export async function runGit(cwd, args, { allowFailure = false, input = null, signal = null } = {}) {
  const result = await runProcess('git', args, { cwd, input, timeoutMs: 120_000, signal });
  if (!result.ok && !allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`;
    throw new Error(detail);
  }
  return result;
}

async function unstagePaths(projectPath, paths, { signal = null } = {}) {
  for (const chunk of chunks(paths, 100)) {
    await runGit(projectPath, ['reset', '-q', 'HEAD', '--', ...chunk], { allowFailure: true, signal });
  }
}

function parsePorcelain(output) {
  const tokens = output.split('\0');
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const status = token.slice(0, 2);
    let filePath = token.slice(3);
    let originalPath = null;
    if (status.includes('R') || status.includes('C')) {
      originalPath = tokens[index + 1] || null;
      index += 1;
    }
    filePath = normalizeGitPath(filePath);
    entries.push({
      status,
      indexStatus: status[0],
      worktreeStatus: status[1],
      path: filePath,
      originalPath: originalPath ? normalizeGitPath(originalPath) : null,
    });
  }
  return entries;
}

function splitNullPaths(value) {
  return value.split('\0').filter(Boolean).map(normalizeGitPath).sort();
}

function isConflictStatus(status) {
  return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(status);
}

function normalizeGitPath(value) {
  return String(value).split(path.sep).join('/');
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export async function getCommitRewriteCandidates(projectPath, runs, { maxCommits = 3, currentPaths = [] } = {}) {
  const status = await getGitStatus(projectPath);
  if (status.staged.length || status.conflicted.length) return [];
  const log = await runGit(projectPath, ['log', `-${maxCommits}`, '--format=%H%x09%P%x09%s'], { allowFailure: true });
  if (!log.ok) return [];
  const entries = log.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [revision, parents = '', subject = ''] = line.split('\t');
    return { revision, parents: parents.split(' ').filter(Boolean), subject };
  });
  const currentPathSet = new Set(currentPaths);
  const knownRuns = runs.filter((run) => run.commit?.revision).map((run) => {
    const changedPaths = [...new Set(run.applied?.paths ?? [])].sort();
    return {
      runId: run.id,
      revision: run.commit.revision,
      message: run.commit.message,
      createdAt: run.createdAt,
      archiveName: run.archivePath ? path.basename(run.archivePath) : null,
      summary: run.llm?.summary ?? [],
      changedPaths,
      overlappingPaths: changedPaths.filter((item) => currentPathSet.has(item)),
    };
  });
  const mapped = [];
  for (const entry of entries) {
    const run = knownRuns.find((item) => entry.revision.startsWith(item.revision) || item.revision.startsWith(entry.revision));
    const published = await isCommitPublished(projectPath, entry.revision);
    mapped.push({ ...entry, run, published, eligible: Boolean(run && entry.parents.length === 1 && !published) });
  }
  const result = [];
  if (mapped[0]?.eligible) result.push({
    id: 'amend-head', kind: 'amend', count: 1,
    revision: mapped[0].revision, runIds: [mapped[0].run.runId],
    commits: [rewriteContext(mapped[0])],
    label: `Amend unpublished Zipflow commit ${mapped[0].revision.slice(0, 8)}`,
  });
  for (let count = 2; count <= Math.min(maxCommits, mapped.length); count += 1) {
    const slice = mapped.slice(0, count);
    if (!slice.every((item) => item.eligible)) break;
    result.push({
      id: `squash-${count}`, kind: 'squash', count,
      revision: slice[0].revision, runIds: slice.map((item) => item.run.runId),
      commits: slice.map(rewriteContext),
      label: `Squash ${count} unpublished Zipflow commits with this update`,
    });
  }
  return result;
}

function rewriteContext(item) {
  return {
    revision: item.revision,
    subject: item.subject,
    runId: item.run.runId,
    message: item.run.message,
    createdAt: item.run.createdAt,
    archiveName: item.run.archiveName,
    summary: item.run.summary,
    changedPaths: item.run.changedPaths,
    overlappingPaths: item.run.overlappingPaths,
  };
}

export async function amendZipflowCommit(projectPath, { runId, paths, message, candidate, signal = null }) {
  const eligibility = await validateRewriteState(projectPath, candidate, { signal });
  if (!eligibility.ok) return eligibility;
  const backupRef = await createRewriteBackupRef(projectPath, runId, { signal });
  try {
    const staged = await stageCommitPaths(projectPath, paths, { signal });
    if (!staged.ok) return { ...staged, backupRef };
    const commit = await runGit(projectPath, ['commit', '--amend', '-m', message], { allowFailure: true, signal });
    if (!commit.ok) {
      await restoreRewriteRef(projectPath, backupRef);
      return { ok: false, reason: commit.stderr.trim() || commit.stdout.trim() || 'git commit --amend failed', backupRef };
    }
    const revision = await runGit(projectPath, ['rev-parse', '--short', 'HEAD'], { signal });
    return { ok: true, revision: revision.stdout.trim(), paths: staged.paths, backupRef, rewrittenRunIds: candidate.runIds };
  } catch (error) {
    await restoreRewriteRef(projectPath, backupRef).catch(() => {});
    throw error;
  }
}

export async function squashZipflowCommits(projectPath, { runId, paths, message, candidate, signal = null }) {
  if (!Number.isInteger(candidate?.count) || candidate.count < 2 || candidate.count > 3) {
    return { ok: false, reason: 'The requested squash is outside the supported 2–3 commit range.' };
  }
  const eligibility = await validateRewriteState(projectPath, candidate, { signal });
  if (!eligibility.ok) return eligibility;
  const backupRef = await createRewriteBackupRef(projectPath, runId, { signal });
  try {
    const reset = await runGit(projectPath, ['reset', '--soft', `HEAD~${candidate.count}`], { allowFailure: true, signal });
    if (!reset.ok) return { ok: false, reason: reset.stderr.trim() || reset.stdout.trim() || 'git reset --soft failed', backupRef };
    const staged = await stageCommitPaths(projectPath, paths, { signal });
    if (!staged.ok) {
      await restoreRewriteRef(projectPath, backupRef);
      return { ...staged, backupRef };
    }
    const commit = await runGit(projectPath, ['commit', '-m', message], { allowFailure: true, signal });
    if (!commit.ok) {
      await restoreRewriteRef(projectPath, backupRef);
      return { ok: false, reason: commit.stderr.trim() || commit.stdout.trim() || 'git squash commit failed', backupRef };
    }
    const revision = await runGit(projectPath, ['rev-parse', '--short', 'HEAD'], { signal });
    return { ok: true, revision: revision.stdout.trim(), paths: staged.paths, backupRef, rewrittenRunIds: candidate.runIds };
  } catch (error) {
    await restoreRewriteRef(projectPath, backupRef).catch(() => {});
    throw error;
  }
}

async function validateRewriteState(projectPath, candidate, { signal = null } = {}) {
  if (!candidate?.eligible && candidate?.eligible !== undefined) return { ok: false, reason: 'The selected commit is not eligible for rewriting.' };
  const status = await getGitStatus(projectPath);
  if (status.staged.length) return { ok: false, reason: 'The Git index contains staged user changes.' };
  if (status.conflicted.length) return { ok: false, reason: 'The repository contains unresolved merge conflicts.' };
  const head = await runGit(projectPath, ['rev-parse', 'HEAD'], { allowFailure: true, signal });
  if (!head.ok || !candidate?.revision || !head.stdout.trim().startsWith(candidate.revision) && !candidate.revision.startsWith(head.stdout.trim())) {
    return { ok: false, reason: 'Git HEAD changed after the rewrite option was prepared.' };
  }
  return { ok: true };
}

async function restoreRewriteRef(projectPath, backupRef) {
  await runGit(projectPath, ['reset', '--mixed', backupRef], { allowFailure: true });
}

async function createRewriteBackupRef(projectPath, runId, { signal = null } = {}) {
  const ref = `refs/zipflow/checkpoints/${runId}-rewrite`;
  const update = await runGit(projectPath, ['update-ref', ref, 'HEAD'], { allowFailure: true, signal });
  if (!update.ok) throw new Error(update.stderr.trim() || update.stdout.trim() || 'Could not create Git rewrite backup ref.');
  return ref;
}

async function isCommitPublished(projectPath, revision) {
  const branches = await runGit(projectPath, ['branch', '-r', '--contains', revision], { allowFailure: true });
  return branches.ok && Boolean(branches.stdout.trim());
}

async function stageCommitPaths(projectPath, paths, { signal = null } = {}) {
  const requestedPaths = [...new Set(paths)].filter(Boolean);
  const safePaths = requestedPaths.filter((item) => !isProtectedProjectPath(item));
  const ignored = await listIgnoredPaths(projectPath, safePaths);
  const uniquePaths = safePaths.filter((item) => !ignored.has(normalizeGitPath(item)));
  if (!uniquePaths.length) return { ok: false, reason: 'There are no committable applied paths.' };
  for (const chunk of chunks(uniquePaths, 100)) {
    const add = await runGit(projectPath, ['add', '--all', '--', ...chunk], { allowFailure: true, signal });
    if (!add.ok) {
      await unstagePaths(projectPath, uniquePaths, { signal });
      return { ok: false, reason: add.stderr.trim() || add.stdout.trim() || 'git add failed' };
    }
  }
  return { ok: true, paths: uniquePaths };
}
