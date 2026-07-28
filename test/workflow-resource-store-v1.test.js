import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import {
  parseRevisionEtag,
  WorkflowResourceStore,
  workflowEtag,
} from '../src/application/workflow-resource-store.js';
import { loadWorkflow, saveWorkflow } from '../src/workflow/store.js';

test('workflow resources use a CAS revision distinct from workflow format version', async (t) => {
  const fixture = await setupFixture(t);
  const store = await new WorkflowResourceStore({
    root: path.join(fixture.home, 'server', 'workflow-revisions'),
    now: tickingClock(),
  }).initialize();

  const empty = await store.get(fixture.project);
  assert.deepEqual(empty, { revision: 0, workflow: null });

  const first = await store.replace({
    project: fixture.project,
    draft: workflowDraft(fixture.project.canonicalPath, 'first'),
    expectedRevision: 0,
  });
  assert.equal(first.revision, 1);
  assert.equal(first.workflow.version, 9);
  assert.equal(first.workflow.name, 'first');
  assert.equal(workflowEtag(first.revision), '"1"');
  assert.equal(parseRevisionEtag('"1"'), 1);

  const restarted = await new WorkflowResourceStore({
    root: path.join(fixture.home, 'server', 'workflow-revisions'),
  }).initialize();
  assert.equal((await restarted.get(fixture.project)).revision, 1);

  const attempts = await Promise.allSettled([
    restarted.replace({
      project: fixture.project,
      draft: workflowDraft(fixture.project.canonicalPath, 'left'),
      expectedRevision: 1,
    }),
    restarted.replace({
      project: fixture.project,
      draft: workflowDraft(fixture.project.canonicalPath, 'right'),
      expectedRevision: 1,
    }),
  ]);
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = attempts.find(({ status }) => status === 'rejected');
  assert.equal(rejected.reason.code, 'STALE_REVISION');
  assert.equal(rejected.reason.details.currentRevision, 2);
});

test('direct legacy workflow changes are detected as a new server revision', async (t) => {
  const fixture = await setupFixture(t);
  const store = await new WorkflowResourceStore({
    root: path.join(fixture.home, 'server', 'workflow-revisions'),
  }).initialize();
  await store.replace({
    project: fixture.project,
    draft: workflowDraft(fixture.project.canonicalPath, 'server'),
    expectedRevision: 0,
  });

  const legacy = await loadWorkflow(fixture.project.canonicalPath);
  await saveWorkflow({ ...legacy, name: 'legacy edit' });
  const observed = await store.get(fixture.project);
  assert.equal(observed.revision, 2);
  assert.equal(observed.workflow.name, 'legacy edit');
  assert.equal((await store.get(fixture.project)).revision, 2);
});

test('workflow replacement rejects stale tags and project identity changes without mutation', async (t) => {
  const fixture = await setupFixture(t);
  const store = await new WorkflowResourceStore({
    root: path.join(fixture.home, 'server', 'workflow-revisions'),
  }).initialize();
  const original = await store.replace({
    project: fixture.project,
    draft: workflowDraft(fixture.project.canonicalPath, 'original'),
    expectedRevision: 0,
  });

  await assert.rejects(
    store.replace({
      project: fixture.project,
      draft: workflowDraft(fixture.project.canonicalPath, 'stale'),
      expectedRevision: 0,
    }),
    (error) => error?.code === 'STALE_REVISION',
  );
  await assert.rejects(
    store.replace({
      project: fixture.project,
      draft: workflowDraft(path.dirname(fixture.project.canonicalPath), 'wrong project'),
      expectedRevision: 1,
    }),
    (error) => error?.code === 'ACTION_INPUT_INVALID',
  );
  assert.equal((await store.get(fixture.project)).workflow.name, original.workflow.name);
  assert.throws(() => parseRevisionEtag('1'), (error) => error?.code === 'STALE_REVISION');
});

async function setupFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-workflow-resource-'));
  const home = path.join(root, 'home');
  const projectPath = path.join(root, 'project');
  await mkdir(projectPath, { recursive: true });
  const canonicalPath = await realpath(projectPath);
  await mkdir(path.join(home, 'server'), { recursive: true, mode: 0o700 });
  const previousHome = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  return {
    home,
    project: {
      projectId: 'project_fixture',
      canonicalPath,
    },
  };
}

function workflowDraft(projectPath, name) {
  return {
    version: 9,
    name,
    projectPath,
    checks: [],
    archive: { mode: 'overlay' },
    deletion: { scope: 'tracked-only' },
    policy: { id: 'practical' },
    git: { checkpoint: 'never', resultCommit: 'never' },
    deploy: { policy: 'disabled', commandText: '', cwd: '.' },
  };
}

function tickingClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 28, 0, 0, tick++));
}
