import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import {
  inspectUploadedArchive,
  publicPlanFromExecutable,
  selectArchiveRootAndPlan,
  updateExecutableDecision,
} from '../src/application/archive-runner.js';
import { normalizeWorkflow } from '../src/workflow/defaults.js';
import { createZip } from '../test-support/helpers.js';
import { hashFile } from '../src/utils/hash.js';

test('headless archive runner binds a verified blob and persists executable decisions privately', async (t) => {
  const fixture = await archiveFixture(t, {
    'new-file.txt': 'created by archive\n',
  });
  const progress = [];
  const result = await inspectUploadedArchive({
    runId: 'run_archive_fixture',
    project: fixture.project,
    workflow: fixture.workflow,
    workflowRevision: 3,
    blob: fixture.blob,
    onProgress: (event) => progress.push(event.phase),
  });

  assert.equal(result.outcome, 'waiting_action');
  assert.equal(result.attention, 'plan');
  assert.equal(result.binding.workflowRevision, 3);
  assert.equal(result.executable.binding.blob.sha256, fixture.blob.sha256);
  assert.equal(result.public.plan.files[0].path, 'new-file.txt');
  assert.equal(JSON.stringify(result.public).includes(fixture.project.root), false);
  assert.deepEqual(progress, ['extracting', 'choosing_root', 'metadata', 'safety', 'ready']);

  const kept = updateExecutableDecision(result.executable, 'new-file.txt', 'keep');
  assert.equal(publicPlanFromExecutable(kept).selected, 0);
  assert.equal(result.executable.decisions[0].decision, 'archive');
  await assert.rejects(
    async () => updateExecutableDecision(result.executable, '../outside', 'keep'),
    (error) => error?.code === 'ACTION_INPUT_INVALID',
  );
});

test('headless archive root selection uses the same domain decision as the TUI', async (t) => {
  const fixture = await archiveFixture(t, {
    'bundle/package.json': '{"name":"fixture","version":2}\n',
    'bundle/src/a.js': 'export const a = 2;\n',
    'bundle/src/b.js': 'export const b = 2;\n',
  }, {
    projectFiles: {
      'package.json': '{"name":"fixture","version":1}\n',
      'src/a.js': 'export const a = 1;\n',
      'src/b.js': 'export const b = 1;\n',
    },
  });
  const inspected = await inspectUploadedArchive({
    runId: 'run_root_fixture',
    project: fixture.project,
    workflow: fixture.workflow,
    workflowRevision: 1,
    blob: fixture.blob,
  });
  assert.equal(inspected.attention, 'archive_root');
  assert.deepEqual(
    inspected.public.archiveRootChoices.map(({ id }) => id),
    ['use-wrapper-root', 'keep-wrapper-directory'],
  );

  const selected = await selectArchiveRootAndPlan({
    runId: 'run_root_fixture',
    project: fixture.project,
    workflow: fixture.workflow,
    executable: inspected.executable,
    rootId: 'use-wrapper-root',
  });
  assert.equal(selected.public.plan.counts.updated, 3);
  assert.equal(selected.public.plan.counts.created, 0);
  assert.equal(selected.attention, 'conflicts');
  await assert.rejects(
    selectArchiveRootAndPlan({
      runId: 'run_root_fixture',
      project: fixture.project,
      workflow: fixture.workflow,
      executable: inspected.executable,
      rootId: 'unknown-root',
    }),
    (error) => error?.code === 'ACTION_INPUT_INVALID',
  );
});

test('headless archive runner rejects a blob whose immutable hash binding changed', async (t) => {
  const fixture = await archiveFixture(t, { 'file.txt': 'content\n' });
  await assert.rejects(
    inspectUploadedArchive({
      runId: 'run_tampered_blob',
      project: fixture.project,
      workflow: fixture.workflow,
      workflowRevision: 1,
      blob: { ...fixture.blob, sha256: '0'.repeat(64) },
    }),
    (error) => error?.code === 'SERVER_STORAGE_CORRUPT',
  );
});

async function archiveFixture(t, archiveFiles, { projectFiles = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-archive-runner-'));
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  for (const [relative, content] of Object.entries(projectFiles)) {
    const target = path.join(projectRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const archivePath = await createZip(path.join(root, 'uploaded.zip'), archiveFiles);
  const details = await stat(archivePath);
  const sha256 = await hashFile(archivePath);
  const previousHome = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const project = {
    root: projectRoot,
    name: 'fixture',
    git: null,
    checks: [],
    technologies: [],
    labels: [],
  };
  return {
    project,
    workflow: normalizeWorkflow({
      version: 9,
      name: 'fixture',
      projectPath: projectRoot,
      checks: [],
      exclude: [],
      archive: { mode: 'overlay' },
      deletion: { scope: 'tracked-only' },
      policy: { conflictPolicy: 'ask', confirmPlan: true },
      git: { checkpoint: 'never', resultCommit: 'never' },
      deploy: { policy: 'disabled', commandText: '', cwd: '.' },
    }),
    blob: {
      blobId: `sha256:${sha256}`,
      sha256,
      size: details.size,
      filename: 'uploaded.zip',
      createdAt: new Date(details.mtimeMs).toISOString(),
      path: archivePath,
    },
  };
}
