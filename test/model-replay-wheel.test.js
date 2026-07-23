import test from 'node:test';
import assert from 'node:assert/strict';
import { Text, themes } from 'terlio.js';
import { renderModelReplayWorkspace } from '../src/ui/model-replay-view.js';

function findNode(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

function previewState() {
  const actions = [];
  const state = {
    settingsPanel: {
      modelTestWorkspace: {
        mode: 'preview', previewIndex: 0, runId: 'run-1', archiveName: 'update.zip',
        run: { plan: { counts: { created: 1, updated: 2, deleted: 0 } } },
      },
    },
    dispatch: (action) => actions.push(action),
  };
  return { state, actions };
}

test('historical replay preview wheel moves one action and does not wrap', () => {
  const { state, actions } = previewState();
  let tree = renderModelReplayWorkspace({ content: Text('background'), state, width: 100, height: 24, theme: themes.ocean });
  let region = findNode(tree.props.manager.top().node, (node) => node.props?.pointerId === 'zipflow:model-replay-preview');

  region.props.onWheel({ deltaY: 1, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(actions.pop(), { type: 'model-replay-preview-select', index: 1 });

  state.settingsPanel.modelTestWorkspace.previewIndex = 1;
  tree = renderModelReplayWorkspace({ content: Text('background'), state, width: 100, height: 24, theme: themes.ocean });
  region = findNode(tree.props.manager.top().node, (node) => node.props?.pointerId === 'zipflow:model-replay-preview');
  region.props.onWheel({ deltaY: 1, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(actions.pop(), { type: 'model-replay-preview-select', index: 1 });
});
