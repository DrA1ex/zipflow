import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveInternalBinary } from '../security/binaries.js';
import { ByteChunkCollector } from '../utils/byte-buffer.js';
import { ZIPFLOW_VERSION } from '../version.js';
import { classifyServerError, LocalLlmError } from './errors.js';

const STDERR_LIMIT = 256 * 1024;

export async function listCodexAppServerModels({
  settings = null,
  signal = null,
  timeoutMs = 15_000,
  spawnImpl = nodeSpawn,
  executable = '',
} = {}) {
  return withCodexClient({ settings, signal, timeoutMs, spawnImpl, executable }, async (client) => {
    const models = [];
    let cursor = null;
    do {
      const result = await client.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      models.push(...(result?.data ?? []));
      cursor = result?.nextCursor ?? null;
    } while (cursor && models.length < 1_000);
    return models.map((entry) => {
      const id = entry.model || entry.id;
      return {
        id,
        key: id,
        label: entry.displayName || id,
        displayName: entry.displayName || id,
        loaded: null,
        contextLength: null,
        reasoningOptions: (entry.supportedReasoningEfforts ?? [])
          .map((item) => item.reasoningEffort || item.effort)
          .filter(Boolean),
        reasoningDefault: entry.defaultReasoningEffort ?? null,
        isDefault: Boolean(entry.isDefault),
        inputModalities: entry.inputModalities ?? ['text', 'image'],
      };
    }).filter((item) => item.id)
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.label.localeCompare(right.label));
  });
}

export async function createCodexAppServerCompletion({
  model,
  messages,
  responseSchema = null,
  reasoningEffort = 'auto',
  maxTokens = 1_024,
}, {
  settings = null,
  signal = null,
  timeoutMs = 600_000,
  idleTimeoutMs = 120_000,
  rpcTimeoutMs = 15_000,
  maxAnswerBytes = 5 * 1024 * 1024,
  maxReasoningBytes = 5 * 1024 * 1024,
  onEvent = () => {},
  spawnImpl = nodeSpawn,
  executable = '',
} = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'zipflow-codex-'));
  try {
    return await withCodexClient({ settings, signal, timeoutMs: rpcTimeoutMs, spawnImpl, executable }, async (client) => {
      const content = new ByteChunkCollector(maxAnswerBytes, { label: 'Codex answer' });
      const reasoning = new ByteChunkCollector(maxReasoningBytes, { label: 'Codex reasoning' });
      let finalContent = '';
      let usage = null;
      let chunks = 0;
      let threadId = null;
      let turnId = null;
      let completed = false;
      let completionSettled = false;
      let timersStarted = false;
      let idleTimer = null;
      let deadlineTimer = null;
      let settle;
      let fail;
      const completion = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
      const resolveCompletion = () => {
        if (completionSettled) return false;
        completionSettled = true;
        settle();
        return true;
      };
      const rejectCompletion = (error) => {
        if (completionSettled) return false;
        completionSettled = true;
        fail(error);
        return true;
      };
      const resetIdle = () => {
        if (!timersStarted || completionSettled) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => rejectCompletion(new LocalLlmError(
          `Codex app-server produced no events for ${Math.round(idleTimeoutMs / 1000)} seconds.`,
          { code: 'idle_timeout', provider: 'codex', retryableWithSmallerPrompt: true },
        )), idleTimeoutMs);
      };
      const startCompletionTimers = () => {
        if (timersStarted || completionSettled) return;
        timersStarted = true;
        resetIdle();
        deadlineTimer = setTimeout(() => rejectCompletion(new LocalLlmError(
          `Codex app-server did not complete within ${Math.round(timeoutMs / 1000)} seconds. Partial output was preserved.`,
          { code: 'total_deadline', provider: 'codex', retryableWithSmallerPrompt: true },
        )), timeoutMs);
      };

      client.onNotification = (message) => {
        resetIdle();
        const method = message.method;
        const params = message.params ?? {};
        if (method === 'item/agentMessage/delta') {
          const delta = textValue(params.delta ?? params.text);
          if (delta) {
            content.append(delta);
            chunks += 1;
            onEvent({ type: 'chunk', contentDelta: delta, reasoningDelta: '', chunks });
          }
        } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
          const delta = textValue(params.delta ?? params.text);
          if (delta) {
            reasoning.append(delta);
            chunks += 1;
            onEvent({ type: 'chunk', contentDelta: '', reasoningDelta: delta, chunks });
          }
        } else if (method === 'item/completed') {
          const item = params.item ?? {};
          if (item.type === 'agentMessage') finalContent = textValue(item.text ?? item.content);
        } else if (method === 'thread/tokenUsage/updated') {
          usage = params.tokenUsage ?? params.usage ?? usage;
        } else if (method === 'turn/completed') {
          const turn = params.turn ?? {};
          if (turnId && turn.id && turn.id !== turnId) return;
          completed = true;
          if (turn.status === 'completed') resolveCompletion();
          else if (turn.status === 'interrupted') rejectCompletion(new LocalLlmError(
            'Codex app-server interrupted the model turn before completion. Partial output was preserved.',
            { code: signal?.aborted ? 'cancelled' : 'incomplete_generation', provider: 'codex', retryableWithSmallerPrompt: !signal?.aborted },
          ));
          else rejectCompletion(codexTurnError(turn.error));
        }
      };

      const abort = () => {
        if (threadId && turnId) {
          try { client.notify('turn/interrupt', { threadId, turnId }); } catch {}
        }
        rejectCompletion(new LocalLlmError('Codex app-server request cancelled.', { code: 'cancelled', provider: 'codex' }));
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try {
        onEvent({
          type: 'request', attempt: 1, format: responseSchema ? 'json_schema' : 'text',
          transport: 'Codex app-server RPC', endpoint: 'turn/start', model,
          reasoningEffort: normalizedEffort(reasoningEffort) ?? null,
        });
        const threadResult = await client.request('thread/start', {
          model,
          cwd: scratch,
          approvalPolicy: 'never',
          // Keep the thread request compatible with Codex app-server versions
          // that use different enum spellings for the legacy `sandbox` field.
          // The actual execution policy is applied explicitly on turn/start.
          ephemeral: true,
          serviceName: 'zipflow',
        });
        threadId = threadResult?.thread?.id;
        if (!threadId) throw new LocalLlmError('Codex app-server did not return a thread ID.', { code: 'protocol_error', provider: 'codex' });
        const turnResult = await client.request('turn/start', compactObject({
          threadId,
          input: [{ type: 'text', text: codexPrompt(messages, maxTokens) }],
          cwd: scratch,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [scratch] } },
          model,
          effort: normalizedEffort(reasoningEffort),
          outputSchema: responseSchema || undefined,
        }));
        turnId = turnResult?.turn?.id ?? null;
        if (!turnId) throw new LocalLlmError('Codex app-server did not return a turn ID.', { code: 'protocol_error', provider: 'codex' });
        onEvent({ type: 'stream-open' });
        if (signal?.aborted) abort();
        startCompletionTimers();
        await completion;
        if (!completed) throw new LocalLlmError(
          'Codex app-server ended without a turn/completed event. Partial output was preserved.',
          { code: 'incomplete_generation', provider: 'codex', retryableWithSmallerPrompt: true },
        );
        const streamedContent = content.toString();
        const value = {
          content: finalContent || streamedContent,
          reasoning: reasoning.toString(),
          finishReason: 'completed',
          usage,
          chunks,
          contentBytes: Buffer.byteLength(finalContent || streamedContent),
          reasoningBytes: reasoning.byteLength,
          rawResponse: '',
          rawResponseTruncated: false,
        };
        onEvent({ type: 'complete', ...value });
        return value;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        signal?.removeEventListener('abort', abort);
      }
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function withCodexClient(options, task) {
  const binary = options.executable || await resolveInternalBinary('codex', { settings: options.settings });
  const client = new CodexRpcClient(binary, options);
  try {
    await client.start();
    return await task(client);
  } finally {
    await client.close();
  }
}

class CodexRpcClient {
  constructor(executable, { spawnImpl, signal, timeoutMs }) {
    this.executable = executable;
    this.spawnImpl = spawnImpl;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = () => {};
    this.stderr = '';
    this.closed = false;
    this.abortHandler = () => this.failAll(new LocalLlmError(
      'Codex app-server request cancelled.',
      { code: 'cancelled', provider: 'codex' },
    ));
  }

  async start() {
    if (this.signal?.aborted) throw new LocalLlmError('Codex app-server request cancelled.', { code: 'cancelled', provider: 'codex' });
    this.signal?.addEventListener('abort', this.abortHandler, { once: true });
    this.child = this.spawnImpl(this.executable, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: process.env,
    });
    this.child.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_LIMIT);
    });
    this.child.once('error', (error) => this.failAll(classifyServerError(`Could not start Codex app-server: ${error.message}`, { provider: 'codex' })));
    this.child.once('exit', (code, signal) => {
      if (this.closed) return;
      const detail = this.stderr.trim() || `process exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
      this.failAll(new LocalLlmError(`Codex app-server stopped unexpectedly: ${detail}`, {
        code: 'app_server_exited', provider: 'codex', retryableWithSmallerPrompt: false,
      }));
    });
    if (this.signal?.aborted) throw new LocalLlmError('Codex app-server request cancelled.', { code: 'cancelled', provider: 'codex' });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => this.handleLine(line));
    await this.request('initialize', {
      clientInfo: { name: 'zipflow', title: 'Zipflow', version: ZIPFLOW_VERSION },
      capabilities: { experimentalApi: false },
    });
    this.notify('initialized', {});
  }

  request(method, params = {}) {
    if (this.signal?.aborted) return Promise.reject(new LocalLlmError(
      'Codex app-server request cancelled.',
      { code: 'cancelled', provider: 'codex' },
    ));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LocalLlmError(`Codex app-server RPC ${method} timed out.`, { code: 'rpc_timeout', provider: 'codex' }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  write(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new LocalLlmError('Codex app-server stdin is unavailable.', { code: 'app_server_closed', provider: 'codex' });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new LocalLlmError(
        `Codex app-server RPC ${pending.method} failed: ${message.error.message || 'unknown error'}`,
        { code: message.error.code ? `rpc_${message.error.code}` : 'rpc_error', provider: 'codex', diagnostics: message.error },
      ));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      if (/approval|requestUserInput/i.test(message.method)) this.write({ id: message.id, result: { decision: 'decline' } });
      else this.write({ id: message.id, error: { code: -32601, message: 'Zipflow does not support server-initiated requests.' } });
      return;
    }
    if (message.method) this.onNotification(message);
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener('abort', this.abortHandler);
    this.lines?.close();
    this.failAll(new LocalLlmError('Codex app-server session closed.', { code: 'cancelled', provider: 'codex' }));
    const child = this.child;
    if (!child) return;
    child.stdin?.end?.();
    if (child.exitCode !== null && child.exitCode !== undefined) return;
    const exited = waitForChildExit(child, 250);
    if (!child.killed) child.kill('SIGTERM');
    if (await exited) return;
    if (child.exitCode === null || child.exitCode === undefined) child.kill('SIGKILL');
    await waitForChildExit(child, 250);
  }
}


function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    const finish = (value) => {
      if (timer) clearTimeout(timer);
      child.removeListener?.('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    child.once?.('exit', onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function codexPrompt(messages, maxTokens) {
  const body = (messages ?? []).map((message) => `${String(message.role ?? 'user').toUpperCase()}:\n${String(message.content ?? '')}`).join('\n\n');
  return [
    'You are acting only as a text-generation backend for Zipflow.',
    'Do not inspect files, run commands, use tools, browse, or modify anything. Answer only from the text below.',
    `Keep the response within approximately ${Math.max(32, Number(maxTokens) || 1_024)} output tokens.`,
    '',
    body,
  ].join('\n');
}

function codexTurnError(error) {
  const info = error?.codexErrorInfo ?? error?.codex_error_info ?? {};
  const kind = info.type ?? info.kind ?? info;
  const message = error?.message || 'Codex app-server turn failed.';
  if (String(kind).includes('ContextWindowExceeded')) {
    return new LocalLlmError(`The Codex model exceeded its context window. ${message}`, {
      code: 'context_exceeded', provider: 'codex', retryableWithSmallerPrompt: true, diagnostics: error,
    });
  }
  if (/ResponseStreamDisconnected|ResponseStreamConnectionFailed/.test(String(kind))) {
    return new LocalLlmError(`Codex lost the model response stream before completion. ${message}`, {
      code: 'incomplete_generation', provider: 'codex', retryableWithSmallerPrompt: true, diagnostics: error,
    });
  }
  return classifyServerError(message, { provider: 'codex', responseBody: error });
}

function normalizedEffort(value) {
  const effort = String(value ?? '').trim().toLowerCase();
  return effort && effort !== 'auto' ? effort : undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((item) => typeof item === 'string' ? item : item?.text ?? item?.content ?? '').join('');
}
