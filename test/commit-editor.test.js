import test from 'node:test';
import assert from 'node:assert/strict';
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

test('multiline commit editor accepts typing, deletion, and Ctrl+Enter line breaks', async () => {
  const state = fixtureState();
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  controller.showEditor('commit-message', {
    label: 'Commit message', purpose: 'commit-message', multiline: true,
  }, '');

  await controller.handleKey({ name: 'a', printable: true, text: 'a' });
  await controller.handleKey({ name: 'b', printable: true, text: 'b' });
  await controller.handleKey({ name: 'backspace' });
  await controller.handleKey({ name: 'enter', ctrl: true });
  await controller.handleKey({ name: 'c', printable: true, text: 'c' });

  assert.equal(state.editor.value, 'a\nc');
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
