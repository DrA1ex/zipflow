import path from 'node:path';
import { runProcess, runShell } from '../utils/process.js';

export async function runChecks({ workflow, projectPath, changedPaths, onUpdate = null, signal = null }) {
  const checks = workflow.checks.filter((check) => check.selected);
  const results = [];
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    onUpdate?.({ type: 'started', check, index, total: checks.length, results });
    if (signal?.aborted) throw Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' });
    const result = await runCheck(check, { projectPath, changedPaths, signal, onOutput: (event) => onUpdate?.({ type: 'output', check, index, event, results }) });
    const normalized = { ...result, id: check.id, name: check.name, required: check.required !== false, type: check.type };
    results.push(normalized);
    onUpdate?.({ type: 'finished', check, index, total: checks.length, result: normalized, results });
    if (!normalized.ok && normalized.required) break;
  }
  return {
    results,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    skipped: Math.max(0, checks.length - results.length),
    ok: results.every((item) => item.ok || !item.required) && results.length === checks.length,
  };
}

async function runCheck(check, context) {
  if (check.kind === 'node-syntax') return runNodeSyntax(check, context);
  if (check.kind === 'python-syntax') return runPythonSyntax(check, context);
  if (check.kind === 'go-format') return runGoFormat(check, context);
  if (check.kind === 'custom') return runShell(check.commandText, commandOptions(check, context));
  if (check.kind === 'command') {
    const [command, ...args] = check.command;
    return runProcess(command, args, commandOptions(check, context));
  }
  return failureResult(`Unsupported check kind: ${check.kind}`);
}

async function runNodeSyntax(check, context) {
  const files = context.changedPaths.filter((file) => /\.(cjs|mjs|js)$/.test(file));
  return runPerFile(files, (file) => runProcess(process.execPath, ['--check', file], commandOptions(check, context)), 'No changed JavaScript files.');
}

async function runPythonSyntax(check, context) {
  const files = context.changedPaths.filter((file) => file.endsWith('.py'));
  return runPerFile(files, (file) => runProcess(check.interpreter || 'python3', ['-m', 'py_compile', file], commandOptions(check, context)), 'No changed Python files.');
}

async function runGoFormat(check, context) {
  const files = context.changedPaths.filter((file) => file.endsWith('.go'));
  if (!files.length) return successResult('No changed Go files.');
  const result = await runProcess('gofmt', ['-d', ...files], commandOptions(check, context));
  if (result.ok && result.stdout.trim()) return { ...result, ok: false, code: 1, stderr: 'gofmt found formatting differences.\n' };
  return result;
}

async function runPerFile(files, execute, emptyMessage) {
  if (!files.length) return successResult(emptyMessage);
  const outputs = [];
  let durationMs = 0;
  for (const file of files) {
    const result = await execute(file);
    durationMs += result.durationMs;
    outputs.push(result.stdout, result.stderr);
    if (!result.ok) return { ...result, durationMs, stdout: outputs.join('') };
  }
  return { ...successResult(`${files.length} files checked.`), durationMs, stdout: outputs.join('') };
}

function commandOptions(check, context) {
  return {
    cwd: path.resolve(context.projectPath, check.cwd || '.'),
    timeoutMs: check.timeoutMs || 600_000,
    onOutput: context.onOutput,
    signal: context.signal,
  };
}

function successResult(stdout = '') {
  return { ok: true, code: 0, signal: null, timedOut: false, stdout, stderr: '', durationMs: 0 };
}

function failureResult(stderr) {
  return { ok: false, code: 1, signal: null, timedOut: false, stdout: '', stderr, durationMs: 0 };
}
