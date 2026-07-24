import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationBusyError } from '../src/operations/manager.js';
import { showOperationBusy } from '../src/app/operation-feedback.js';

test('operation conflicts stay on the current screen and produce non-fatal feedback', () => {
  const calls = [];
  const controller = {
    state: {
      language: 'English',
      screen: 'plan-review',
      activeOperation: { kind: 'llm-review', label: 'Generating local LLM review' },
    },
    toast(...args) { calls.push(['toast', ...args]); },
    setStatus(value) { this.state.status = value; calls.push(['status', value]); },
  };

  showOperationBusy(controller, new OperationBusyError('apply', 'llm-review'));

  assert.equal(controller.state.screen, 'plan-review');
  assert.match(controller.state.status, /Generating local LLM review is still running/);
  assert.equal(calls[0][0], 'toast');
  assert.match(calls[0][4], /finish or cancel it first/);
});
