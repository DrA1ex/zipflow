import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { beginArchiveInput, submitRunEditor, activateRun } from '../src/app/run-flow.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { discoverProject } from '../src/project/detect.js';
import { createZip, initGit, tempDir, writeFiles } from '../test-support/helpers.js';

test('conflicts first show an Activity summary and bulk choices before per-file selection', async () => {
  const home = await tempDir('zipflow-conflict-home-');
  const root = await tempDir('zipflow-conflict-project-');
  const archive = path.join(await tempDir('zipflow-conflict-archive-'), 'update.zip');
  process.env.ZIPFLOW_HOME = home;
  try {
    await writeFiles(root, {
      'package.json': '{"name":"fixture"}\n',
      'src/index.js': 'baseline\n',
    });
    await initGit(root);
    await writeFile(path.join(root, 'src/index.js'), 'local change\n');
    await createZip(archive, {
      'src/index.js': 'archive change\n',
      'src/new.js': 'created\n',
    });
    const project = await discoverProject(root);
    const workflow = createRecommendedWorkflow(project);
    workflow.git.checkpoint = 'never';
    workflow.checks = [];
    const state = createInitialState();
    state.project = project;
    state.workflow = workflow;
    const controller = new ZipflowController(state);

    beginArchiveInput(controller);
    state.editor.insert(archive);
    await submitRunEditor(controller);

    assert.equal(state.screen, 'conflict-summary');
    assert.ok(state.messages.some((message) => message.title === 'Update plan' && message.lines.some((line) => /src\/index\.js/.test(line))));
    assert.deepEqual(state.menuItems.map((item) => item.id), [
      'replace-all-conflicts',
      'keep-all-conflicts',
      'choose-conflicts',
      'retry-archive',
    ]);

    await activateRun(controller, 'choose-conflicts');
    assert.equal(state.screen, 'conflicts');
    assert.ok(state.menuItems.some((item) => item.id === 'conflict:0'));
    await controller.cleanup();
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});
