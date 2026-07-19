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
} = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (kind, chunk) => {
      const text = chunk.toString();
      if (kind === 'stdout') stdout = trimOutput(stdout + text, outputLimit);
      else stderr = trimOutput(stderr + text, outputLimit);
      onOutput?.({ kind, text });
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (error) => {
      activeChildren.delete(child);
      reject(error);
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, timeoutMs) : null;
    timer?.unref();
    child.on('close', (code, signal) => {
      activeChildren.delete(child);
      if (timer) clearTimeout(timer);
      resolve({
        command,
        args,
        code,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        ok: code === 0 && !timedOut,
      });
    });
  });
}

export async function runShell(command, options = {}) {
  return runProcess(command, [], { ...options, shell: true });
}

export async function terminateActiveProcesses({ graceMs = 500 } = {}) {
  const children = [...activeChildren];
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  if (!children.length) return;
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  for (const child of children) {
    if (activeChildren.has(child) && !child.killed) child.kill('SIGKILL');
  }
}

export function activeProcessCount() {
  return activeChildren.size;
}

function terminateChild(child) {
  if (!child.killed) child.kill('SIGTERM');
  setTimeout(() => {
    if (activeChildren.has(child) && !child.killed) child.kill('SIGKILL');
  }, 2_000).unref();
}

function trimOutput(value, limit) {
  if (Buffer.byteLength(value) <= limit) return value;
  return `[earlier output truncated]\n${value.slice(-Math.floor(limit * 0.9))}`;
}
