import path from 'node:path';
import { runProcess } from '../utils/process.js';
import { isProtectedProjectPath } from '../archive/protected.js';
import { canonicalPath } from '../utils/paths.js';

export async function findGitRoot(startPath) {
  try {
    const result = await runGit(startPath, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    return result.ok ? canonicalPath(result.stdout.trim()) : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

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

export async function createCommit(projectPath, paths, message) {
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
    const add = await runGit(projectPath, ['add', '--all', '--', ...chunk], { allowFailure: true });
    if (!add.ok) {
      await unstagePaths(projectPath, uniquePaths);
      return { ok: false, reason: add.stderr || add.stdout || 'git add failed' };
    }
  }
  const commit = await runGit(projectPath, ['commit', '-m', message], { allowFailure: true });
  if (!commit.ok) {
    await unstagePaths(projectPath, uniquePaths);
    return { ok: false, reason: commit.stderr || commit.stdout || 'git commit failed' };
  }
  const revision = await runGit(projectPath, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, revision: revision.stdout.trim(), output: commit.stdout.trim(), paths: uniquePaths, omittedPaths: requestedPaths.filter((item) => !uniquePaths.includes(item)) };
}

export async function currentRevision(projectPath) {
  const result = await runGit(projectPath, ['rev-parse', '--short', 'HEAD'], { allowFailure: true });
  return result.ok ? result.stdout.trim() : null;
}

export async function runGit(cwd, args, { allowFailure = false, input = null } = {}) {
  const result = await runProcess('git', args, { cwd, input, timeoutMs: 120_000 });
  if (!result.ok && !allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`;
    throw new Error(detail);
  }
  return result;
}

async function unstagePaths(projectPath, paths) {
  for (const chunk of chunks(paths, 100)) {
    await runGit(projectPath, ['reset', '-q', 'HEAD', '--', ...chunk], { allowFailure: true });
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
