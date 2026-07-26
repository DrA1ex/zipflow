import { runProcess } from '../utils/process.js';
import { canonicalPath } from '../utils/paths.js';
import { resolveInternalBinary } from '../security/binaries.js';

export async function findGitRoot(startPath, { settings = null } = {}) {
  try {
    const git = await resolveInternalBinary('git', { settings });
    const result = await runProcess(git, ['rev-parse', '--show-toplevel'], {
      cwd: startPath,
      allowFailure: true,
      timeoutMs: 30_000,
    });
    return result.ok ? canonicalPath(result.stdout.trim()) : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
