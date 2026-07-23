import test from 'node:test';
import assert from 'node:assert/strict';
import {
  moveSelectableIndex,
  nearestSelectableIndex,
  normalizeSelectableIndex,
  pageSelectableIndex,
} from '../src/app/list-navigation.js';

const enabled = (id) => ({ id });
const disabled = (id) => ({ id, disabled: true });

test('plain lists use direct modular movement without scanning behavior', () => {
  const items = Array.from({ length: 6 }, (_, index) => enabled(index));
  assert.equal(moveSelectableIndex(items, 0, 3), 3);
  assert.equal(moveSelectableIndex(items, 5, 1), 0);
  assert.equal(moveSelectableIndex(items, 0, -1), 5);
});

test('non-wrapping movement stops at list boundaries', () => {
  const items = Array.from({ length: 4 }, (_, index) => enabled(index));
  assert.equal(moveSelectableIndex(items, 0, -1, { wrap: false }), 0);
  assert.equal(moveSelectableIndex(items, 3, 1, { wrap: false }), 3);
  assert.equal(moveSelectableIndex(items, 1, 20, { wrap: false }), 3);
});

test('disabled rows are skipped only when a direct target cannot be selected', () => {
  const items = [enabled(0), disabled(1), disabled(2), enabled(3), enabled(4)];
  assert.equal(moveSelectableIndex(items, 0, 1), 3);
  assert.equal(moveSelectableIndex(items, 4, -1), 3);
  assert.equal(moveSelectableIndex(items, 0, 2), 4);
});

test('normalization chooses the nearest selectable row rather than the first row', () => {
  const items = [enabled(0), disabled(1), disabled(2), enabled(3), enabled(4)];
  assert.equal(normalizeSelectableIndex(items, 2), 3);
  assert.equal(nearestSelectableIndex(items, 1), 0);

  const tied = [enabled(0), disabled(1), enabled(2)];
  assert.equal(normalizeSelectableIndex(tied, 1), 2);
  assert.equal(normalizeSelectableIndex(tied, 1, { preferDirection: -1 }), 0);
});

test('page movement never produces an out-of-range index at disabled boundaries', () => {
  const items = [disabled(0), enabled(1)];
  assert.equal(pageSelectableIndex(items, 1, -1, 6), 1);
  assert.equal(pageSelectableIndex(items, 1, 1, 6), 1);
});

test('page movement chooses the nearest selectable row around its target', () => {
  const items = [enabled(0), enabled(1), disabled(2), disabled(3), enabled(4), enabled(5)];
  assert.equal(pageSelectableIndex(items, 0, 1, 3), 4);
  assert.equal(pageSelectableIndex(items, 5, -1, 3), 1);
});
