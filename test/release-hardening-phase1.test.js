import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import {
  builtInPathArgument, goFormatArguments, nodeSyntaxArguments, pythonSyntaxArguments, runChecks,
} from '../src/checks/runner.js';
import { applyUpdatePlan } from '../src/apply/apply.js';
import { acquireProjectLock } from '../src/apply/lock.js';
import { validateZipEntry } from '../src/archive/security.js';
import { hashFile } from '../src/utils/hash.js';
import { readJson, writeJsonAtomic } from '../src/utils/fs.js';
import {
  pruneRunHistory, removeOrphanedTemporaryDirectories, runDirectory,
} from '../src/runs/store.js';
import { ensureZipflowHome, getZipflowHome } from '../src/workflow/store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


test('scoped operation release and command-directory parsing stay deterministic', async () => {
  const { OperationManager } = await import('../src/operations/manager.js');
  const { formatCommandSpec, parseCommandSpec, validateCommandSpec } = await import('../src/project/command-spec.js');
  const manager = new OperationManager();
  await assert.rejects(
    manager.run({ kind: 'checkpoint' }, async () => { throw new Error('checkpoint failed'); }),
    /checkpoint failed/,
  );
  assert.equal(manager.current, null);

  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'zipflow-command-cwd-'));
  await mkdir(path.join(projectPath, 'web app'));
  await mkdir(path.join(projectPath, "owner's app"));
  assert.deepEqual(parseCommandSpec('web/ :: npm test'), {
    input: 'web/ :: npm test', cwd: 'web', commandText: 'npm test', hasExplicitCwd: true,
  });
  assert.deepEqual(parseCommandSpec(`python -c 'print("a::b")'`), {
    input: `python -c 'print("a::b")'`, cwd: '.', commandText: `python -c 'print("a::b")'`, hasExplicitCwd: false,
  });
  assert.equal(formatCommandSpec({ cwd: 'web app', commandText: 'npm test' }), '"web app/" :: npm test');
  assert.equal((await validateCommandSpec(projectPath, '"web app/" :: npm test')).cwd, 'web app');
  const quotedApostrophe = formatCommandSpec({ cwd: "owner's app", commandText: 'npm test' });
  assert.equal((await validateCommandSpec(projectPath, quotedApostrophe)).cwd, "owner's app");
  await assert.rejects(() => validateCommandSpec(projectPath, '../outside/ :: npm test'), /escapes the project root/i);
  await rm(projectPath, { recursive: true, force: true });
});

test('check cancellation propagates without becoming a failed result', async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'zipflow-check-cancel-'));
  const controller = new AbortController();
  const events = [];
  const pending = runChecks({
    projectPath,
    changedPaths: [],
    signal: controller.signal,
    onUpdate: (event) => events.push(event.type),
    workflow: {
      checks: [{
        id: 'cancelled', name: 'Cancelled', kind: 'command', type: 'custom', selected: true, required: true,
        command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: '.', timeoutMs: 30_000,
      }],
    },
  });
  setTimeout(() => controller.abort('cancelled'), 40);
  await assert.rejects(pending, (error) => error.code === 'cancelled');
  assert.deepEqual(events, ['started']);

  const failed = await runChecks({
    projectPath,
    changedPaths: [],
    workflow: {
      checks: [{
        id: 'failed', name: 'Failed', kind: 'command', type: 'custom', selected: true, required: true,
        command: [process.execPath, '-e', 'process.exit(7)'], cwd: '.', timeoutMs: 5_000,
      }],
    },
  });
  assert.equal(failed.failed, 1);
  assert.equal(failed.results[0].ok, false);
  await rm(projectPath, { recursive: true, force: true });
});

test('built-in checks pass every discovered path as a filename', () => {
  for (const file of ['--eval', '--help', '-write.go', '-', 'name with spaces.js', 'Юникод.py']) {
    assert.equal(builtInPathArgument(file), `./${file}`);
  }
  assert.deepEqual(nodeSyntaxArguments('--eval.js'), ['--check', '--', './--eval.js']);
  assert.deepEqual(pythonSyntaxArguments('--help.py'), ['-m', 'py_compile', './--help.py']);
  assert.deepEqual(goFormatArguments(['-write.go', 'with space.go']), ['-d', '--', './-write.go', './with space.go']);
});

test('Node built-in checks execute option-like, spaced, and Unicode filenames', async () => {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'zipflow-check-paths-'));
  const files = ['--eval.js', '--help.js', 'name with spaces.js', 'Юникод.js'];
  for (const file of files) await writeFile(path.join(projectPath, file), 'export const value = 1;\n');
  const result = await runChecks({
    projectPath,
    changedPaths: files,
    workflow: {
      checks: [{ id: 'syntax', name: 'Syntax', kind: 'node-syntax', type: 'syntax', selected: true, required: true, cwd: '.' }],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].code, 0);
  await rm(projectPath, { recursive: true, force: true });
});

test('missing ZIP mode metadata preserves an existing executable mode', async () => {
  await withZipflowHome(async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'zipflow-mode-project-'));
    const sourcePath = path.join(projectPath, 'archive-script');
    const targetPath = path.join(projectPath, 'script.sh');
    await writeFile(sourcePath, '#!/bin/sh\necho new\n');
    await writeFile(targetPath, '#!/bin/sh\necho old\n');
    await chmod(targetPath, 0o755);
    const plan = {
      created: [], deleted: [], conflicts: [],
      updated: [{
        kind: 'updated', path: 'script.sh', sourcePath, currentPath: targetPath,
        beforeHash: await hashFile(targetPath), afterHash: await hashFile(sourcePath), mode: null,
      }],
    };
    await applyUpdatePlan({ runId: 'zf-phase1-mode', projectPath, plan });
    assert.equal((await stat(targetPath)).mode & 0o777, 0o755);
    assert.match(await readFile(targetPath, 'utf8'), /echo new/);
    await rm(projectPath, { recursive: true, force: true });
  });
});

test('ZIP mode parsing distinguishes missing metadata from explicit modes', () => {
  const base = {
    fileName: 'script.sh', generalPurposeBitFlag: 0, externalFileAttributes: 0,
    uncompressedSize: 10, compressedSize: 10,
  };
  assert.equal(validateZipEntry({ ...base, versionMadeBy: 20 }).mode, null);
  assert.equal(validateZipEntry({
    ...base,
    versionMadeBy: (3 << 8) | 20,
    externalFileAttributes: (0o100644 << 16) >>> 0,
  }).mode, 0o644);
});

test('durable JSON replacement never exposes partially valid JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zipflow-atomic-json-'));
  const target = path.join(directory, 'settings.json');
  await writeJsonAtomic(target, { generation: 0 });
  let writing = true;
  const reads = (async () => {
    while (writing) {
      const value = JSON.parse(await readFile(target, 'utf8'));
      assert.equal(Number.isInteger(value.generation), true);
    }
  })();
  await Promise.all(Array.from({ length: 30 }, (_, generation) => writeJsonAtomic(target, { generation: generation + 1 })));
  writing = false;
  await reads;
  assert.equal((await stat(target)).mode & 0o777, 0o600);

  const before = await readFile(target, 'utf8');
  const circular = {};
  circular.self = circular;
  await assert.rejects(writeJsonAtomic(target, circular), /circular/i);
  assert.equal(await readFile(target, 'utf8'), before);

  await interruptAtomicWriter(target, directory);
  assert.doesNotThrow(() => JSON.parse(readFileSync(target, 'utf8')));
  await rm(directory, { recursive: true, force: true });
});

test('project locks use one static owner record and reclaim dead or expired owners', async () => {
  await withZipflowHome(async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'zipflow-lock-project-'));
    const first = await acquireProjectLock(projectPath, 'run-one');
    const before = await readFile(first.path, 'utf8');
    await first.heartbeat();
    assert.equal(await readFile(first.path, 'utf8'), before);
    await assert.rejects(acquireProjectLock(projectPath, 'run-two'), /Another Zipflow run is active/);
    await first.release();

    const stale = {
      version: 3, pid: process.pid, projectPath, runId: 'stale-run', ownerToken: 'stale-owner',
      createdAt: '2020-01-01T00:00:00.000Z',
    };
    await writeJsonAtomic(first.path, stale);
    const replacement = await acquireProjectLock(projectPath, 'replacement', {
      now: () => Date.parse('2026-07-25T12:00:00.000Z'), staleAfterMs: 1_000, isProcessAlive: () => true,
    });
    const stored = await readJson(replacement.path);
    assert.equal(stored.runId, 'replacement');
    assert.notEqual(stored.ownerToken, stale.ownerToken);

    await writeJsonAtomic(replacement.path, { ...stored, ownerToken: 'successor-owner', runId: 'successor' });
    await replacement.release();
    assert.equal((await readJson(replacement.path)).runId, 'successor');
    await rm(replacement.path, { force: true });

    const dead = { ...stale, createdAt: new Date().toISOString(), runId: 'dead-owner' };
    await writeJsonAtomic(first.path, dead);
    const afterDead = await acquireProjectLock(projectPath, 'after-dead', { isProcessAlive: () => false });
    assert.equal((await readJson(afterDead.path)).runId, 'after-dead');
    await afterDead.release();
    await rm(projectPath, { recursive: true, force: true });
  });
});

test('run retention removes old and oversized history without pruning active or retained runs', async () => {
  await withZipflowHome(async () => {
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    await createStoredRun('old-complete', 'completed', now - 100 * 24 * 60 * 60_000, 512);
    await createStoredRun('active-run', 'created', now - 100 * 24 * 60 * 60_000, 512);
    await createStoredRun('retained-run', 'completed', now - 100 * 24 * 60 * 60_000, 512, { retained: true });
    await createStoredRun('interrupted-run', 'interrupted', now - 100 * 24 * 60 * 60_000, 512);
    await createStoredRun('new-complete', 'completed', now - 1_000, 512);
    const aged = await pruneRunHistory({ now, retentionDays: 30, maxBytes: 10_000_000 });
    assert.deepEqual(aged.removed, ['old-complete']);
    assert.equal(await directoryExists(runDirectory('active-run')), true);
    assert.equal(await directoryExists(runDirectory('retained-run')), true);
    assert.equal(await directoryExists(runDirectory('interrupted-run')), true);

    await createStoredRun('old-large', 'completed', now - 2_000, 4_096);
    const sized = await pruneRunHistory({ now, retentionDays: 365, maxBytes: 2_000 });
    assert.ok(sized.removed.includes('old-large') || sized.removed.includes('new-complete'));
    assert.equal(await directoryExists(runDirectory('active-run')), true);
    assert.equal(await directoryExists(runDirectory('retained-run')), true);
    assert.equal(await directoryExists(runDirectory('interrupted-run')), true);
  });
});

test('startup cleanup removes only orphaned or terminal temporary directories', async () => {
  await withZipflowHome(async () => {
    await createStoredRun('active-temp', 'planned', Date.now(), 1);
    await createStoredRun('terminal-temp', 'completed', Date.now(), 1);
    const tempRoot = path.join(getZipflowHome(), 'tmp');
    for (const id of ['active-temp', 'terminal-temp', 'orphan-temp']) {
      await mkdir(path.join(tempRoot, id), { recursive: true });
      await writeFile(path.join(tempRoot, id, 'data'), id);
    }
    const removed = await removeOrphanedTemporaryDirectories();
    assert.deepEqual(removed.sort(), ['orphan-temp', 'terminal-temp']);
    assert.equal(await directoryExists(path.join(tempRoot, 'active-temp')), true);
  });
});

async function withZipflowHome(callback) {
  const previous = process.env.ZIPFLOW_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), 'zipflow-phase1-home-'));
  process.env.ZIPFLOW_HOME = home;
  try {
    await ensureZipflowHome();
    return await callback(home);
  } finally {
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

async function createStoredRun(id, status, createdAt, payloadSize, extra = {}) {
  const directory = runDirectory(id);
  await mkdir(directory, { recursive: true });
  await writeJsonAtomic(path.join(directory, 'report.json'), {
    version: 9, id, status, createdAt: new Date(createdAt).toISOString(), ...extra,
  });
  await writeFile(path.join(directory, 'payload.bin'), Buffer.alloc(payloadSize));
}

async function directoryExists(target) {
  try { return (await stat(target)).isDirectory(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function interruptAtomicWriter(target, directory) {
  const moduleUrl = pathToFileURL(path.join(root, 'src', 'utils', 'fs.js')).href;
  const code = `import { writeJsonAtomic } from ${JSON.stringify(moduleUrl)}; await writeJsonAtomic(process.argv[1], { generation: 999, payload: 'x'.repeat(128 * 1024 * 1024) });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, target], { stdio: 'ignore' });
  const closed = new Promise((resolve) => child.once('close', resolve));
  let sawTemporary = false;
  for (let attempt = 0; attempt < 1_000 && child.exitCode === null; attempt += 1) {
    const entries = await readdir(directory);
    if (entries.some((entry) => entry.startsWith('settings.json.') && entry.endsWith('.tmp'))) {
      sawTemporary = true;
      child.kill('SIGKILL');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!sawTemporary && child.exitCode === null) child.kill('SIGKILL');
  await closed;
}
