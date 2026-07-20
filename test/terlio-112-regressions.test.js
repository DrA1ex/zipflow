import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  ScrollPane, Text, renderToString, themes,
} from 'terlio.js';
import { createInitialState, appendMessage } from '../src/app/state.js';
import { buildTranscript } from '../src/ui/activity.js';
import { renderModelReplayWorkspace } from '../src/ui/model-replay-view.js';
import { buildUpdatePlan } from '../src/plan/build.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { discoverProject } from '../src/project/detect.js';
import { extractedFixture, initGit, tempDir, writeFiles } from '../test-support/helpers.js';

test('snapshot deletion always preserves gitignore and sensitive local data', async () => {
  const root = await tempDir('zipflow-delete-protected-');
  await writeFiles(root, {
    '.gitignore': '.zipflow/\n',
    '.npmrc': '//registry.npmjs.org/:_authToken=secret\n',
    'config/credentials.json': '{"token":"secret"}\n',
    'data/local.sqlite': 'private data\n',
    'package.json': '{"name":"fixture"}\n',
    'src/remove.js': 'remove me\n',
  });
  await initGit(root);
  const project = await discoverProject(root);
  const workflow = createRecommendedWorkflow(project);
  workflow.archive.mode = 'snapshot';
  workflow.deletion.scope = 'all';
  workflow.exclude.push('archive/**');
  const extracted = await extractedFixture(root, {
    'package.json': await readFile(path.join(root, 'package.json'), 'utf8'),
  });

  const plan = await buildUpdatePlan({ project, workflow, extracted });

  assert.deepEqual(plan.deleted.map((item) => item.path), ['src/remove.js']);
  const preserved = new Map(plan.preserved.map((item) => [item.path, item.reason]));
  for (const protectedPath of ['.gitignore', '.npmrc', 'config/credentials.json', 'data/local.sqlite']) {
    assert.equal(preserved.has(protectedPath), true, `${protectedPath} should be preserved`);
    assert.match(preserved.get(protectedPath), /protected/i);
  }
});

test('historical replay keeps status in a fixed modal header above scrolled output', () => {
  const state = createInitialState();
  state.settingsPanel = {
    modelTestWorkspace: {
      mode: 'progress', runId: 'run-1', archiveName: 'update.zip', running: true,
      status: 'Receiving model response', elapsedMs: 2_500,
      blocks: Array.from({ length: 30 }, (_, index) => ({
        id: `block-${index}`, title: `Block ${index}`, lines: [`line ${index}`],
        reasoning: '', content: '', status: 'done', streaming: false,
      })),
      scroll: 80, maxScroll: 100, follow: false, unread: 0, unreadBlockIds: new Set(),
    },
  };
  const tree = renderModelReplayWorkspace({ content: Text('BACKGROUND'), state, width: 100, height: 28, theme: themes.ocean });
  const overlay = tree.props.manager.top();
  assert.equal(typeof overlay.render, 'function');
  const output = stripAnsi(renderToString(tree, { width: 100, height: 28 }));
  assert.ok(output.indexOf('Receiving model response') >= 0);
  assert.ok(output.indexOf('Receiving model response') < output.indexOf('REPLAY OUTPUT'));
  assert.match(output, /update\.zip · 2\.5s/);
});

test('expanded 10k-line Activity blocks reuse their prepared transcript between scroll renders', () => {
  const state = createInitialState();
  appendMessage(state, 'Large test log', Array.from({ length: 10_000 }, (_, index) => `log line ${index}`), 'process');
  state.messages[0].collapsed = false;

  const first = buildTranscript(state, themes.ocean, 100);
  const second = buildTranscript(state, themes.ocean, 100);

  assert.equal(second, first);
  assert.equal(second.lines, first.lines);
  assert.ok(first.lines.length >= 10_001);
});

test('Terlio 1.1.2 ScrollPane reads only the visible window from a 10k-line source', () => {
  let reads = 0;
  const source = {
    length: 10_000,
    getLine(index) {
      reads += 1;
      return `log line ${index}`;
    },
  };
  const node = ScrollPane({ lines: source, width: 80, height: 12, scroll: 9_000 });
  const output = renderToString(node, { width: 80, height: 12 });

  assert.match(output, /log line 9000/);
  assert.ok(reads < 50, `expected viewport-sized reads, received ${reads}`);
});

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '');
}
