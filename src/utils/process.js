import { spawn } from 'node:child_process';
import { BoundedByteBuffer, ByteChunkCollector } from './byte-buffer.js';

const DEFAULT_OUTPUT_LIMIT = 5 * 1024 * 1024;
const OUTPUT_UPDATE_BYTES = 64 * 1024;
const activeChildren = new Set();

export async function runProcess(command, args = [], {
  cwd,
  env,
  inheritEnv = true,
  timeoutMs = 600_000,
  shell = false,
  input = null,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
  outputUpdateIntervalMs = 50,
  onOutput = null,
  signal = null,
} = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: inheritEnv ? { ...process.env, ...env } : { ...(env ?? {}) },
      shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    activeChildren.add(child);
    const stdoutBuffer = new BoundedByteBuffer(outputLimit);
    const stderrBuffer = new BoundedByteBuffer(outputLimit);
    let timedOut = false;
    let cancelled = false;
    let outputTimer = null;
    const newPendingCollector = (kind) => new ByteChunkCollector(OUTPUT_UPDATE_BYTES, {
      label: `${kind} update`,
      segmentBytes: OUTPUT_UPDATE_BYTES,
    });
    const pendingOutput = {
      stdout: newPendingCollector('stdout'),
      stderr: newPendingCollector('stderr'),
    };
    const notifyOutput = (kind, chunk) => {
      const buffer = kind === 'stdout' ? stdoutBuffer : stderrBuffer;
      onOutput?.({ kind, text: chunk.toString(), chunk, retainedBytes: buffer.byteLength, truncated: buffer.truncated });
    };
    const flushOutput = () => {
      if (outputTimer) clearTimeout(outputTimer);
      outputTimer = null;
      for (const kind of ['stdout', 'stderr']) {
        const collector = pendingOutput[kind];
        if (!collector.byteLength) continue;
        pendingOutput[kind] = newPendingCollector(kind);
        notifyOutput(kind, collector.toBuffer());
      }
    };
    const scheduleOutput = (kind, chunk) => {
      if (!onOutput) return;
      if (chunk.length >= OUTPUT_UPDATE_BYTES) {
        flushOutput();
        notifyOutput(kind, chunk);
        return;
      }
      if (pendingOutput[kind].byteLength + chunk.length > OUTPUT_UPDATE_BYTES) flushOutput();
      pendingOutput[kind].append(chunk);
      if (outputUpdateIntervalMs <= 0 || pendingOutput[kind].byteLength >= OUTPUT_UPDATE_BYTES) {
        flushOutput();
        return;
      }
      if (!outputTimer) {
        outputTimer = setTimeout(flushOutput, outputUpdateIntervalMs);
        outputTimer.unref?.();
      }
    };
    const append = (kind, chunk) => {
      const buffer = kind === 'stdout' ? stdoutBuffer : stderrBuffer;
      buffer.append(chunk);
      scheduleOutput(kind, chunk);
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    const abort = () => {
      cancelled = true;
      terminateChild(child);
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => {
      flushOutput();
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
      flushOutput();
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
        stdout: outputText(stdoutBuffer),
        stderr: outputText(stderrBuffer),
        stdoutBytes: stdoutBuffer.byteLength,
        stderrBytes: stderrBuffer.byteLength,
        stdoutTruncated: stdoutBuffer.truncated,
        stderrTruncated: stderrBuffer.truncated,
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

function outputText(buffer) {
  if (!buffer.truncated) return buffer.toString();
  const marker = Buffer.from('[earlier output truncated by byte limit]\n');
  if (buffer.maxBytes <= marker.length) return marker.subarray(0, buffer.maxBytes).toString();
  const available = buffer.maxBytes - marker.length;
  let tail = buffer.toBuffer().subarray(Math.max(0, buffer.byteLength - available));
  while (tail.length && (tail[0] & 0xc0) === 0x80) tail = tail.subarray(1);
  let text = tail.toString('utf8');
  while (Buffer.byteLength(text) > available) text = text.slice(1);
  return `${marker.toString()}${text}`;
}
