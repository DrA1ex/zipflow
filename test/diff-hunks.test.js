import test from 'node:test';
import assert from 'node:assert/strict';
import { changedRanges, renderDiffDocument } from '../src/diff/hunks.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { handleReviewKey } from '../src/app/run-review.js';

function same(number, text = `line ${number}`) {
  return { type: 'same', oldNo: number, newNo: number, oldText: text, newText: text };
}

function remove(number, text) {
  return { type: 'remove', oldNo: number, newNo: null, oldText: text, newText: '' };
}

function add(number, text) {
  return { type: 'add', oldNo: null, newNo: number, oldText: '', newText: text };
}

function twoHunkDiff() {
  const rows = [];
  for (let number = 1; number <= 24; number += 1) rows.push(same(number));
  rows.splice(2, 1, remove(3, 'old first'), add(3, 'new first'));
  rows.splice(19, 1, remove(19, 'old second'), add(19, 'new second'));
  return { binary: false, rows, path: 'src/example.js', kind: 'updated' };
}

test('changed ranges merge nearby changes and keep distant changes as separate hunks', () => {
  const ranges = changedRanges(twoHunkDiff().rows, 2);
  assert.equal(ranges.length, 2);
  assert.ok(ranges[0].end < ranges[1].start);
});

test('unified and side-by-side documents expose stable hunk offsets', () => {
  const diff = twoHunkDiff();
  const unified = renderDiffDocument(diff, 'unified', 100, { context: 2 });
  const side = renderDiffDocument(diff, 'side-by-side', 120, { context: 2 });

  assert.equal(unified.hunkCount, 2);
  assert.equal(side.hunkCount, 2);
  assert.equal(unified.hunkOffsets.length, 2);
  assert.equal(side.hunkOffsets.length, 2);
  assert.ok(unified.hunkOffsets[1] > unified.hunkOffsets[0]);
  assert.ok(side.hunkOffsets[1] > side.hunkOffsets[0]);
  assert.equal(unified.lines[unified.hunkOffsets[0]].type, 'hunk');
  assert.equal(side.lines[side.hunkOffsets[1]].type, 'hunk');
});

test('N and P navigate hunks cyclically without changing the diff mode', () => {
  const state = createInitialState();
  state.screen = 'diff-view';
  state.diffView = {
    mode: 'unified', hunkIndex: 0, hunkCount: 3, hunkOffsets: [0, 12, 24], scroll: 0,
  };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  assert.equal(handleReviewKey(controller, { name: 'n' }), true);
  assert.equal(state.diffView.hunkIndex, 1);
  assert.equal(state.diffView.scroll, 12);
  assert.equal(state.diffView.mode, 'unified');

  handleReviewKey(controller, { name: 'p' });
  assert.equal(state.diffView.hunkIndex, 0);
  handleReviewKey(controller, { name: 'p' });
  assert.equal(state.diffView.hunkIndex, 2);
  assert.equal(state.diffView.scroll, 24);
});
