import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { showDuplicateWarning } from '../src/app/run-duplicate.js';
import { bindScreenAction, captureScreenActionContext } from '../src/app/ui-action-context.js';

test('a stale archive discovery activation cannot choose an action on the duplicate warning', async () => {
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture' };
  state.workflow = { checks: [], deploy: { policy: 'disabled' } };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};

  controller.showMenu('archive-discovery', [
    { id: 'archive-candidate:0', label: 'update.zip' },
  ], 'Choose a matching archive');
  const staleAction = bindScreenAction(captureScreenActionContext(state), {
    type: 'activate-index',
    index: 0,
  });

  showDuplicateWarning(controller, '/tmp/update.zip', 'archive-hash', {
    id: 'previous-run',
    status: 'completed',
    createdAt: new Date().toISOString(),
    plan: { counts: { created: 0, updated: 1, deleted: 0, preserved: 0, unchanged: 0, skipped: 0, conflicts: 0 } },
  });

  const result = await controller.dispatch(staleAction);

  assert.equal(result, false);
  assert.equal(state.screen, 'archive-duplicate');
  assert.equal(state.pendingArchive.previous.id, 'previous-run');
  assert.equal(state.menuItems[state.selectedIndex].id, 'duplicate-choose-another');
  assert.equal(state.messages.some((message) => message.title === 'Your choice'), false);
});
