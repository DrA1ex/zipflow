import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { beginArchiveInput, submitRunEditor } from '../src/app/run-flow.js';
import { createRunRecord, saveRunRecord } from '../src/runs/store.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { autonomyForMode } from '../src/autonomy/policies.js';
import { discoverProject } from '../src/project/detect.js';
import { hashFile } from '../src/utils/hash.js';
import { createZip, tempDir, writeFiles } from '../test-support/helpers.js';

test('an archive hash used before produces an explicit repeat warning', async () => {
  const home = await tempDir('zipflow-repeat-home-');
  const root = await tempDir('zipflow-repeat-project-');
  const archive = path.join(await tempDir('zipflow-repeat-archive-'), 'update.zip');
  process.env.ZIPFLOW_HOME = home;
  try {
    await writeFiles(root, { 'package.json': '{"name":"fixture"}\n' });
    await createZip(archive, { 'package.json': '{"name":"fixture","version":"2"}\n' });
    const project = await discoverProject(root);
    const workflow = createRecommendedWorkflow(project);
    workflow.checks = [];
    const previous = await createRunRecord({
      id: 'previous-run', project, workflow, archivePath: archive, archiveHash: await hashFile(archive),
    });
    previous.status = 'completed';
    previous.plan = { counts: { created: 0, updated: 1, deleted: 0, preserved: 0, unchanged: 0, skipped: 0, conflicts: 0 } };
    await saveRunRecord(previous);

    const state = createInitialState();
    state.project = project;
    state.workflow = workflow;
    const controller = new ZipflowController(state);
    beginArchiveInput(controller);
    state.editor.insert(archive);
    await submitRunEditor(controller);

    assert.equal(state.screen, 'archive-duplicate');
    assert.equal(state.pendingArchive.previous.id, 'previous-run');
    assert.equal(state.run, null);
    assert.equal(state.menuItems[0].id, 'duplicate-choose-another');
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});


test('guarded autopilot silently skips an already applied archive when the project still matches', async () => {
  const home = await tempDir('zipflow-repeat-auto-home-');
  const root = await tempDir('zipflow-repeat-auto-project-');
  const archive = path.join(await tempDir('zipflow-repeat-auto-archive-'), 'update.zip');
  process.env.ZIPFLOW_HOME = home;
  try {
    const files = { 'package.json': JSON.stringify({ name: 'fixture', version: '2' }) + '\n' };
    await writeFiles(root, files);
    await createZip(archive, files);
    const project = await discoverProject(root);
    const workflow = createRecommendedWorkflow(project);
    workflow.checks = [];
    workflow.autonomy = autonomyForMode('guarded');
    const previous = await createRunRecord({
      id: 'previous-auto-run', project, workflow, archivePath: archive, archiveHash: await hashFile(archive),
    });
    previous.status = 'completed';
    previous.plan = { counts: { created: 0, updated: 0, deleted: 0, preserved: 0, unchanged: 1, skipped: 0, conflicts: 0 } };
    await saveRunRecord(previous);

    const state = createInitialState();
    state.project = project;
    state.workflow = workflow;
    const controller = new ZipflowController(state);
    beginArchiveInput(controller);
    state.editor.insert(archive);
    await submitRunEditor(controller);

    assert.equal(state.screen, 'archive-input');
    assert.equal(state.busy, false);
    assert.equal(state.messages.some((item) => item.title === 'Archive already applied'), true);
    assert.equal(state.messages.some((item) => item.title === 'Autopilot decision'), false);
    assert.equal(state.run.status, 'duplicate_skipped');
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});
