import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationBusyError, OperationManager, isOperationBusyError } from '../src/operations/manager.js';

test('a concurrent phase raises a typed operation conflict without replacing the active phase', () => {
  const snapshots = [];
  const manager = new OperationManager({ onChange: (value) => snapshots.push(value) });
  const review = manager.begin({ kind: 'llm-review', label: 'Generating local LLM review' });

  assert.throws(
    () => manager.begin({ kind: 'apply', label: 'Applying update' }),
    (error) => error instanceof OperationBusyError
      && isOperationBusyError(error)
      && error.requestedOperation === 'apply'
      && error.activeOperation === 'llm-review',
  );
  assert.equal(manager.current.kind, 'llm-review');
  assert.equal(snapshots.at(-1).kind, 'llm-review');

  review.finish();
  assert.equal(manager.current, null);
});
