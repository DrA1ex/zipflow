import test from 'node:test';
import assert from 'node:assert/strict';
import { bindScreenAction, captureScreenActionContext, isScreenActionCurrent } from '../src/app/ui-action-context.js';

test('screen-bound actions retain the screen generation that rendered them', () => {
  const state = { screen: 'archive-discovery', screenGeneration: 4 };
  const context = captureScreenActionContext(state);
  state.screen = 'archive-duplicate';
  state.screenGeneration = 5;

  const action = bindScreenAction(context, { type: 'activate-index', index: 0 });

  assert.deepEqual(action, {
    type: 'activate-index',
    index: 0,
    sourceScreen: 'archive-discovery',
    sourceGeneration: 4,
  });
  assert.equal(isScreenActionCurrent(state, action), false);
});
