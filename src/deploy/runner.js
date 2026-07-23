import { runShell } from '../utils/process.js';
import { resolveCommandCwd } from '../project/command-spec.js';

export async function runDeploy({ deploy, projectPath, onOutput = null, signal = null }) {
  if (!deploy?.commandText?.trim()) {
    return failureResult('Deploy command is not configured.');
  }
  let cwd;
  try {
    cwd = await resolveCommandCwd(projectPath, deploy.cwd || '.');
  } catch (error) {
    return failureResult(error.message);
  }
  return runShell(deploy.commandText, {
    cwd,
    timeoutMs: deploy.timeoutMs || 900_000,
    onOutput,
    signal,
  });
}

function failureResult(stderr) {
  return { ok: false, code: 1, signal: null, timedOut: false, stdout: '', stderr, durationMs: 0 };
}
