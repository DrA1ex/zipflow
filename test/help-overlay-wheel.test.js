import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'terlio.js';
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
  const render = () => {
    const tree = overlay.render({ width: 50, height: 8 });
    return {
      tree,
      text: renderToString(tree, { width: 50, height: 8 }),
      wheel: findNode(tree, (node) => node.props?.pointerId === 'zipflow:help-overlay'),
    };
  };

  const initial = render();
  assert.ok(initial.wheel?.props?.onWheel);
  assert.match(initial.text, /Help line 1/);
  assert.doesNotMatch(initial.text, /Help line 7/);

  initial.wheel.props.onWheel({ deltaY: 1, preventDefault() {}, stopPropagation() {} });
  const moved = render();
  assert.doesNotMatch(moved.text, /Help line 1/);
  assert.match(moved.text, /Help line 2/);
  assert.match(moved.text, /Help line 7/);

  for (let index = 0; index < 100; index += 1) {
    moved.wheel.props.onWheel({ deltaY: 1, preventDefault() {}, stopPropagation() {} });
  }
  const bottom = render();
  assert.match(bottom.text, /Help line 20/);
  bottom.wheel.props.onWheel({ deltaY: 1, preventDefault() {}, stopPropagation() {} });
  assert.equal(render().text, bottom.text);

  for (let index = 0; index < 100; index += 1) {
    bottom.wheel.props.onWheel({ deltaY: -1, preventDefault() {}, stopPropagation() {} });
  }
  assert.equal(render().text, initial.text);
  assert.ok(invalidations >= 203);
});
