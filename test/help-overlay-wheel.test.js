import test from 'node:test';
import assert from 'node:assert/strict';
import { openHelpOverlay } from '../src/ui/help-overlay.js';

function findNode(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

test('Help wheel scrolls exactly one row and stops at the viewport boundary', () => {
  let overlay = null;
  let invalidations = 0;
  const controller = {
    state: {
      settings: { theme: 'ocean' },
      overlays: { help: (definition) => { overlay = definition; } },
    },
    invalidate: () => { invalidations += 1; },
  };
  const lines = Array.from({ length: 20 }, (_, index) => `Help line ${index + 1}`);

  assert.equal(openHelpOverlay(controller, { title: 'Help', lines }), true);
  const initial = findNode(overlay.render({ width: 50, height: 8 }), (node) => node.props?.pointerId === 'zipflow:help-overlay');
  assert.equal(initial.props.scroll, 0);

  initial.props.onWheel({ deltaY: 1, preventDefault() {}, stopPropagation() {} });
  const moved = findNode(overlay.render({ width: 50, height: 8 }), (node) => node.props?.pointerId === 'zipflow:help-overlay');
  assert.equal(moved.props.scroll, 1);

  moved.props.onWheel({ deltaY: -1, preventDefault() {}, stopPropagation() {} });
  const returned = findNode(overlay.render({ width: 50, height: 8 }), (node) => node.props?.pointerId === 'zipflow:help-overlay');
  assert.equal(returned.props.scroll, 0);
  assert.ok(invalidations >= 3);
});
