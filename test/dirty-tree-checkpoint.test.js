import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { buildDirtyTreeChangeSet } from '../src/git/dirty-tree.js';
import { createCheckpointRef, getGitStatus, runGit } from '../src/git/repository.js';
import { createCheckpointSnapshot } from '../src/app/run-checkpoint.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';

async function tempDir(prefix = 'zipflow-dirty-tree-') {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function initGit(root) {
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'zipflow@test.local']);
  await runGit(root, ['config', 'user.name', 'Zipflow Tests']);
  await runGit(root, ['add', '--all']);
  await runGit(root, ['commit', '-qm', 'fixture']);
}

test('dirty-tree change delivery includes tracked local changes without modifying the user index', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'tracked.txt': 'before\n' });
  await initGit(root);
  await writeFile(path.join(root, 'tracked.txt'), 'after\n');
  await writeFile(path.join(root, 'untracked.txt'), 'local\n');

  const before = await getGitStatus(root);
  const changeSet = await buildDirtyTreeChangeSet(root);

  assert.equal(changeSet.entries.length, 1);
  assert.equal(changeSet.entries[0].path, 'tracked.txt');
  assert.deepEqual(changeSet.plan.counts, { created: 0, updated: 1, deleted: 0 });
  assert.match(changeSet.patchContent, /diff --git a\/tracked\.txt b\/tracked\.txt/);
  assert.match(changeSet.patchContent, /-before/);
  assert.match(changeSet.patchContent, /\+after/);
  const after = await getGitStatus(root);
  assert.deepEqual(after.entries, before.entries);
});

test('checkpoint refs preserve a supplied LLM commit message and leave the dirty tree untouched', async () => {
  const root = await tempDir('zipflow-checkpoint-message-');
  await writeFiles(root, { 'tracked.txt': 'before\n' });
  await initGit(root);
  await writeFile(path.join(root, 'tracked.txt'), 'after\n');
  const before = await getGitStatus(root);

  const result = await createCheckpointRef(root, 'run-1', { message: 'Describe local checkpoint changes' });

  assert.equal(result.ok, true);
  assert.equal(result.message, 'Describe local checkpoint changes');
  const subject = await runGit(root, ['show', '-s', '--format=%s', result.ref]);
  assert.match(subject.stdout, /Describe local checkpoint changes/);
  const after = await getGitStatus(root);
  assert.deepEqual(after.entries, before.entries);
});


function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

test('checkpoint creation uses the dirty-tree LLM task and stores the generated message', async () => {
  const root = await tempDir('zipflow-checkpoint-llm-');
  await writeFiles(root, { 'tracked.txt': 'before\n' });
  await initGit(root);
  await writeFile(path.join(root, 'tracked.txt'), 'after\n');
  const previousFetch = globalThis.fetch;
  let chatBody;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/v1/models')) {
      return jsonResponse({
        models: [{
          type: 'llm', key: 'fixture', max_context_length: 32_000,
          loaded_instances: [{ id: 'fixture-loaded', config: { context_length: 32_000 } }],
          capabilities: { reasoning: { allowed_options: ['off'], default: 'off' } },
        }],
      });
    }
    chatBody = JSON.parse(options.body);
    return jsonResponse({
      output: [{ type: 'message', content: 'COMMIT MESSAGE:\nPreserve local bridge work' }],
      stats: { input_tokens: 50, total_output_tokens: 8 },
    });
  };
  try {
    const state = {
      project: { name: 'fixture', root, labels: ['Node.js'] },
      run: { id: 'run-llm' },
      settings: {
        ...DEFAULT_SETTINGS,
        llmProvider: 'lmstudio', llmModel: 'fixture-loaded',
        llmUseArchiveReview: false, llmUseSummary: false,
        llmUseCommitMessage: false, llmUseDirtyTreeCommitMessage: true,
        llmChangeDelivery: 'change-list', llmVerboseOutput: false,
      },
      messages: [], llmRuntime: null,
    };
    const controller = {
      state,
      invalidate() {},
      message(title, lines, kind, options = {}) {
        state.messages.push({ title, lines, kind, ...options });
      },
    };
    const abortController = new AbortController();
    const phases = [];
    const checkpoint = await createCheckpointSnapshot(controller, {
      operation: { signal: abortController.signal, update(value) { phases.push(value); } },
    });

    assert.equal(checkpoint.ok, true);
    assert.equal(checkpoint.message, 'Preserve local bridge work');
    assert.equal(checkpoint.messageSource, 'llm');
    assert.match(chatBody.input, /Current uncommitted tracked working-tree changes/);
    assert.match(chatBody.input, /UPDATE tracked\.txt/);
    assert.ok(phases.some((item) => item.phase === 'Generating dirty-tree checkpoint message'));
    const subject = await runGit(root, ['show', '-s', '--format=%s', checkpoint.ref]);
    assert.equal(subject.stdout.trim(), 'Preserve local bridge work');
    assert.equal((await getGitStatus(root)).entries[0].path, 'tracked.txt');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
