import { runProcess } from '../utils/process.js';
import { canonicalPath } from '../utils/paths.js';

export async function findGitRoot(startPath) {
  try {
    const result = await runProcess('git', ['rev-parse', '--show-toplevel'], {
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
