import test from 'node:test';
import assert from 'node:assert/strict';
import { serverCommitMessage } from '../src/application/workflow-commit-message.js';

test('server commit message preserves LLM, metadata, fixed, archive, and deterministic strategies', () => {
  const state = {
    binding: {
      runId: 'run-1',
      projectPath: '/private/fixture',
      blob: { filename: 'update.zip' },
    },
    workflow: { git: { messageStrategy: 'metadata', fixedMessage: 'Apply {projectName} {runId}' } },
    metadata: { commitMessage: 'Archive supplied message' },
    llm: { commitMessage: 'Local model message' },
  };
  assert.equal(serverCommitMessage(state, 'run-1'), 'Archive supplied message');
  state.workflow.git.messageStrategy = 'llm';
  assert.equal(serverCommitMessage(state, 'run-1'), 'Local model message');
  state.workflow.git.messageStrategy = 'fixed';
  assert.equal(serverCommitMessage(state, 'run-1'), 'Apply fixture run-1');
  state.workflow.git.messageStrategy = 'archive';
  assert.equal(serverCommitMessage(state, 'run-1'), 'Apply update.zip');
  state.workflow.git.messageStrategy = 'metadata';
  state.metadata.commitMessage = '';
  state.llm.commitMessage = '';
  assert.equal(serverCommitMessage(state, 'run-1'), 'zipflow: apply run-1');
});

test('LLM-only strategy keeps the editor empty when the requested model task returned no message', () => {
  const state = {
    binding: { runId: 'run-2', projectPath: '/private/fixture', blob: { filename: 'update.zip' } },
    workflow: { git: { messageStrategy: 'llm', fixedMessage: 'ignored' } },
    metadata: { commitMessage: 'Metadata fallback must not hide the missing LLM result.' },
    llm: { commitMessage: '' },
  };
  assert.equal(serverCommitMessage(state, 'run-2'), '');
});
