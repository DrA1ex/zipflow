import { terminalRunStatus } from '../server/run-session-model.js';

const DEFAULT_SETTLEMENT_ATTEMPTS = 50;
const DEFAULT_SETTLEMENT_DELAY_MS = 10;

export async function projectAcceptsNewRun({
  sessions,
  operations,
  projectId,
  attempts = DEFAULT_SETTLEMENT_ATTEMPTS,
  delayMs = DEFAULT_SETTLEMENT_DELAY_MS,
} = {}) {
  const activeSessions = (await sessions.list({ projectId }))
    .filter((session) => !terminalRunStatus(session.run.status));
  if (activeSessions.length) return false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const active = await operations.list({ projectId, activeOnly: true });
    if (!active.length) return true;
    const runStates = await Promise.all(active.map((operation) => (
      operation.runId ? sessions.get(operation.runId) : null
    )));
    const settlingTerminalRuns = runStates.every((session) => (
      session && terminalRunStatus(session.run.status)
    ));
    if (!settlingTerminalRuns) return false;
    await delay(delayMs);
  }
  return (await operations.list({ projectId, activeOnly: true })).length === 0;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
