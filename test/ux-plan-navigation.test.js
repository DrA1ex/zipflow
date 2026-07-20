import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'terlio.js';
import { createInitialState, appendMessage, setScreen } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { activateSetup, backSetup, beginSetup } from '../src/app/setup-flow.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { renderZipflow } from '../src/ui/render.js';
import {
  matchesRunStatus, matchesRunType, runTypeDescription, runTypeTag,
} from '../src/history/presentation.js';
import { showRunDetails } from '../src/app/run-rollback.js';

function projectFixture(root = '/tmp/fixture') {
  return {
    name: 'fixture', root, labels: ['Node.js'], technologies: [{ id: 'node' }], git: true,
    checks: [
      { id: 'test', name: 'Unit tests', commandText: 'npm test', selected: true },
      { id: 'lint', name: 'Lint', commandText: 'npm run lint', selected: true },
    ],
  };
}

test('run presentation distinguishes archive updates, manual tests, and manual deployments', () => {
  const update = { status: 'completed' };
  const manualTest = { kind: 'manual-checks', status: 'completed' };
  const manualDeploy = { kind: 'manual-deploy', status: 'completed_with_errors', deploy: { ok: false } };

  assert.equal(runTypeTag(update), 'UPDATE');
  assert.equal(runTypeTag(manualTest), 'TEST');
  assert.equal(runTypeTag(manualDeploy), 'DEPLOY');
  assert.equal(matchesRunType(manualTest, 'test'), true);
  assert.equal(matchesRunType(manualTest, 'update'), false);
  assert.equal(matchesRunStatus(manualDeploy, 'failed'), true);
  assert.match(runTypeDescription(manualTest), /no file diff or rollback/i);
});

test('manual run details explain why archive diff actions are unavailable', () => {
  const state = createInitialState();
  state.project = projectFixture();
  state.run = {
    id: 'manual-1', kind: 'manual-checks', status: 'completed', projectPath: state.project.root,
    checks: { passed: 2, failed: 0 }, decisions: [],
  };
  const controller = new ZipflowController(state);

  showRunDetails(controller, state.run, { origin: 'history', announce: false });

  assert.equal(state.menuItems.some((item) => item.id === 'view-run-diff'), false);
  assert.match(state.panelIntro.join(' '), /\[TEST\]/);
  assert.match(state.panelIntro.join(' '), /no file diff or rollback/i);
});

test('workflow review is a detailed final page with save and back only', async () => {
  const state = createInitialState();
  state.project = projectFixture();
  state.workflow = createRecommendedWorkflow(state.project);
  const controller = new ZipflowController(state);

  await beginSetup(controller, { fresh: false });
  await activateSetup(controller, 'section-review');

  assert.equal(state.screen, 'setup-review');
  assert.deepEqual(state.menuItems.map((item) => item.id), ['save-workflow', 'review-back']);
  assert.match(state.panelIntro.join('\n'), /PROJECT[\s\S]*CHECKS[\s\S]*UPDATE POLICY[\s\S]*ARCHIVE INTERPRETATION[\s\S]*GIT[\s\S]*DEPLOYMENT/);
  assert.doesNotMatch(state.messages.map((item) => item.title).join('\n'), /Workflow ready/);

  backSetup(controller);
  assert.equal(state.screen, 'setup-sections');
  assert.equal(state.menuItems[state.selectedIndex].id, 'section-review');
});

test('Activity exposes a separate clickable unread indicator while preserving scroll position', () => {
  const state = createInitialState();
  state.project = projectFixture();
  for (let index = 0; index < 12; index += 1) appendMessage(state, `Entry ${index + 1}`, [`Line ${index + 1}`]);
  state.transcriptSticky = false;
  state.transcriptScroll = 0;
  state.activityUnread = 3;
  setScreen(state, 'home', { items: [{ id: 'noop', label: 'No action' }], status: 'Ready' });

  const tree = renderZipflow({ state, width: 100, height: 30 });
  const indicator = findNode(tree, (node) => node.props?.pointerId === 'zipflow:activity-unread');
  const output = renderToString(tree, { width: 100, height: 30 });

  assert.ok(indicator);
  assert.match(output, /3 new Activity entries/);
  assert.equal(state.transcriptSticky, false);
  assert.equal(state.transcriptScroll, 0);
});

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  for (const pane of node.props?.panes ?? []) {
    const found = findNode(pane.node, predicate);
    if (found) return found;
  }
  return null;
}
