import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRowIndex, selectRowLabel, selectRows } from '../src/ui/select-rows.js';

test('SelectList rows contain only one physical label and interaction state', () => {
  const rows = selectRows([
    {
      id: 'first',
      label: 'First',
      description: 'Must stay in the context dock',
      disabledReason: 'Must not be appended by Terlio',
      disabled: true,
    },
  ], (item) => item.label);

  assert.deepEqual(rows, [{
    id: 'first', label: 'First', disabled: true, blocked: false, loading: false, sourceIndex: 0,
  }]);
  assert.equal('description' in rows[0], false);
  assert.equal('disabledReason' in rows[0], false);
  assert.equal(selectRowIndex(rows[0], 9), 0);
});


test('SelectList rows remove accidentally duplicated inline help from translated labels', () => {
  const item = {
    id: 'language',
    label: 'Язык',
    description: 'Выберите язык интерфейса Zipflow.',
  };
  const rows = selectRows([item], (value) => `${value.label} — ${value.description}`);
  assert.equal(rows[0].label, 'Язык');
  assert.equal(selectRowLabel('First\nsecond'), 'First second');
});
