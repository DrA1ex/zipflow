import { spawn } from 'node:child_process';

const DEFAULT_OUTPUT_LIMIT = 5 * 1024 * 1024;
const activeChildren = new Set();

export async function runProcess(command, args = [], {
  cwd,
  env,
  timeoutMs = 600_000,
  shell = false,
  input = null,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
  onOutput = null,
  signal = null,
} = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    const append = (kind, chunk) => {
      const text = chunk.toString();
      if (kind === 'stdout') stdout = trimOutput(stdout + text, outputLimit);
      else stderr = trimOutput(stderr + text, outputLimit);
      onOutput?.({ kind, text });
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    const abort = () => {
      cancelled = true;
      terminateChild(child);
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => {
      activeChildren.delete(child);
      signal?.removeEventListener('abort', abort);
      if (cancelled || signal?.aborted) {
        const cancelledError = new Error('Operation cancelled.');
        cancelledError.code = 'cancelled';
        reject(cancelledError);
      } else reject(error);
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, timeoutMs) : null;
    timer?.unref();
    child.on('close', (code, childSignal) => {
      activeChildren.delete(child);
      signal?.removeEventListener('abort', abort);
      if (timer) clearTimeout(timer);
      if (cancelled || signal?.aborted) {
        const error = new Error('Operation cancelled.');
        error.code = 'cancelled';
        reject(error);
        return;
      }
      resolve({
        command,
        args,
        code,
        signal: childSignal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        ok: code === 0 && !timedOut,
      });
    });
    if (signal?.aborted) abort();
  });
}

export async function runShell(command, options = {}) {
  return runProcess(command, [], { ...options, shell: true });
}

export async function terminateActiveProcesses({ graceMs = 500 } = {}) {
  const children = [...activeChildren];
  for (const child of children) terminateChild(child, 'SIGTERM');
  if (!children.length) return;
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  for (const child of children) {
    if (activeChildren.has(child)) terminateChild(child, 'SIGKILL', { scheduleKill: false });
  }
}

export function activeProcessCount() {
  return activeChildren.size;
}

function terminateChild(child, signal = 'SIGTERM', { scheduleKill = signal !== 'SIGKILL' } = {}) {
  signalChildTree(child, signal);
  if (!scheduleKill) return;
  setTimeout(() => {
    if (activeChildren.has(child)) signalChildTree(child, 'SIGKILL');
  }, 2_000).unref();
}

function signalChildTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      try { child.kill(signal); } catch {}
      return;
    }
  }
  try { child.kill(signal); } catch {}
}

function trimOutput(value, limit) {
  if (Buffer.byteLength(value) <= limit) return value;
  return `[earlier output truncated]\n${value.slice(-Math.floor(limit * 0.9))}`;
}
