import path from 'node:path';
import { runShell } from '../utils/process.js';

export async function runDeploy({ deploy, projectPath, onOutput = null, signal = null }) {
  if (!deploy?.commandText?.trim()) {
    return failureResult('Deploy command is not configured.');
  }
  return runShell(deploy.commandText, {
    cwd: path.resolve(projectPath, deploy.cwd || '.'),
    timeoutMs: deploy.timeoutMs || 900_000,
    onOutput,
    signal,
  });
}

function failureResult(stderr) {
  return { ok: false, code: 1, signal: null, timedOut: false, stdout: '', stderr, durationMs: 0 };
}
