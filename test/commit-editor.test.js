import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKey } from 'terlio.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { commitMessageEditorInitialValue, defaultCommitMessage } from '../src/app/run-postcheck.js';

test('commit editor starts empty after an LLM failure instead of showing model JSON', () => {
  const state = fixtureState();
  state.run.llm = { error: 'LM Studio returned an empty response.', raw: '{"summary":["draft"]}' };

  assert.equal(commitMessageEditorInitialValue(state), '');
  assert.equal(defaultCommitMessage(state), 'zipflow: apply run-1');
});

test('JSON-looking LLM commit output is rejected as a commit message', () => {
  const state = fixtureState();
  state.run.llm = { commitMessage: '{"summary":["Updated files"],"commitMessage":"Nested"}' };

  assert.equal(commitMessageEditorInitialValue(state), '');
  assert.equal(defaultCommitMessage(state), 'zipflow: apply run-1');
});

test('multiline commit editor uses Shift+Enter and Ctrl+J as line breaks', async () => {
  const state = fixtureState();
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  controller.showEditor('commit-message', {
    label: 'Commit message', purpose: 'commit-message', multiline: true,
  }, '');

  await controller.handleKey({ name: 'a', printable: true, text: 'a' });
  await controller.handleKey({ name: 'b', printable: true, text: 'b' });
  await controller.handleKey({ name: 'backspace' });
  await controller.handleKey({ name: 'enter', shift: true });
  await controller.handleKey({ name: 'c', printable: true, text: 'c' });
  await controller.handleKey({ name: 'enter', ctrl: true, sequence: '\n' });
  await controller.handleKey({ name: 'd', printable: true, text: 'd' });

  assert.equal(state.editor.value, 'a\nc\nd');
});

test('terminal Shift+Enter, Ctrl+J, and Command+Enter sequences keep editor semantics', async () => {
  const state = fixtureState();
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  controller.showEditor('commit-message', {
    label: 'Commit message', purpose: 'commit-message', multiline: true,
  }, 'Subject');
  let submissions = 0;
  controller.submitCurrentEditor = async () => { submissions += 1; };

  await controller.handleKey(parseKey('\x1b[13;2u'));
  await controller.handleKey({ name: 'b', printable: true, text: 'B' });
  await controller.handleKey(parseKey('\n'));
  await controller.handleKey({ name: 'c', printable: true, text: 'C' });
  await controller.handleKey(parseKey('\x1b[13;9u'));

  assert.equal(state.editor.value, 'Subject\nB\nC');
  assert.equal(submissions, 0);
});

test('modified Enter never submits a single-line editor', async () => {
  const state = fixtureState();
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  controller.showEditor('archive-input', {
    label: 'Archive path', purpose: 'archive-path', multiline: false,
  }, '/tmp/update.zip');
  let submissions = 0;
  controller.submitCurrentEditor = async () => { submissions += 1; };

  await controller.handleKey({ name: 'enter', ctrl: true, sequence: '\n' });
  await controller.handleKey({ name: 'enter', shift: true });
  await controller.handleKey({ name: 'enter', cmd: true });

  assert.equal(submissions, 0);
  assert.equal(state.editor.value, '/tmp/update.zip');
});

function fixtureState() {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture' };
  state.workflow = {
    git: { messageStrategy: 'llm', fixedMessage: '' },
    deploy: { policy: 'disabled' },
  };
  state.run = { id: 'run-1', archivePath: '/tmp/update.zip', llm: null };
  state.archiveMetadata = null;
  return state;
}

test('multiline paste is inserted atomically and does not submit the commit editor', async () => {
  const state = fixtureState();
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  controller.showEditor('commit-message', {
    label: 'Commit message', purpose: 'commit-message', multiline: true,
  }, 'Subject');
  let submissions = 0;
  controller.submitCurrentEditor = async () => { submissions += 1; };

  await controller.handleKey({ name: 'paste', text: '\n\nBody line one\nBody line two' });

  assert.equal(state.editor.value, 'Subject\n\nBody line one\nBody line two');
  assert.equal(submissions, 0);
});

test('concurrent Enter events create only one commit submission', async () => {
  const state = fixtureState();
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  controller.showEditor('commit-message', {
    label: 'Commit message', purpose: 'commit-message', multiline: true,
  }, 'Subject');
  let submissions = 0;
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  controller.submitCurrentEditor = async () => { submissions += 1; await blocker; };

  const first = controller.handleKey({ name: 'enter' });
  const second = controller.handleKey({ name: 'enter' });
  await Promise.resolve();
  assert.equal(submissions, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(submissions, 1);
});

test('plain and Shift-modified printable shortcuts are inserted while an editor is active', async () => {
  const state = fixtureState();
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  controller.showEditor('commit-message', {
    label: 'Commit message', purpose: 'commit-message', multiline: true,
  }, '');

  await controller.handleKey({ name: 'g', printable: true, text: 'g' });
  await controller.handleKey({ name: 'g', printable: true, text: 'G', shift: true });
  await controller.handleKey({ name: '?', printable: true, text: '?' });
  await controller.handleKey({ name: '/', printable: true, text: '/' });
  await controller.handleKey({ name: 'e', printable: true, text: 'e' });

  assert.equal(state.editor.value, 'gG?/e');
  assert.equal(state.screen, 'commit-message');
});
