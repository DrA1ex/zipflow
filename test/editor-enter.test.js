import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKey } from 'terlio.js';
import { isEditorLineBreak, isModifiedEnter, isPlainEnter } from '../src/app/editor-enter.js';

test('terminal Enter variants preserve multiline and submit semantics', () => {
  const plain = parseKey('\r');
  const ctrlJ = parseKey('\n');
  const shiftEnter = parseKey('\x1b[13;2u');
  const commandEnter = parseKey('\x1b[13;9u');

  assert.equal(isPlainEnter(plain), true);
  assert.equal(isEditorLineBreak(plain, { multiline: true }), false);

  assert.equal(isPlainEnter(ctrlJ), false);
  assert.equal(isEditorLineBreak(ctrlJ, { multiline: true }), true);
  assert.equal(isEditorLineBreak(ctrlJ, { multiline: false }), false);

  assert.equal(isPlainEnter(shiftEnter), false);
  assert.equal(isEditorLineBreak(shiftEnter, { multiline: true }), true);
  assert.equal(isEditorLineBreak(shiftEnter, { multiline: false }), false);

  assert.equal(isPlainEnter(commandEnter), false);
  assert.equal(isEditorLineBreak(commandEnter, { multiline: true }), false);
  assert.equal(isModifiedEnter(commandEnter), true);
});
