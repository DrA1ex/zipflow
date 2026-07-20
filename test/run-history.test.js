import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunRecord, findAppliedArchiveRun, listProjectRuns, saveRunRecord } from '../src/runs/store.js';
import { tempDir } from '../test-support/helpers.js';

test('project history is sorted and finds previously applied archive hashes', async () => {
  const home = await tempDir('zipflow-history-home-');
  const project = await tempDir('zipflow-history-project-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const workflow = { name: 'fixture' };
    const projectInfo = { root: project, name: 'fixture' };
    const first = await createRunRecord({ id: 'run-old', project: projectInfo, workflow, archivePath: '/tmp/old.zip', archiveHash: 'same' });
    first.createdAt = '2026-01-01T00:00:00.000Z';
    first.status = 'completed';
    await saveRunRecord(first);
    const second = await createRunRecord({ id: 'run-new', project: projectInfo, workflow, archivePath: '/tmp/new.zip', archiveHash: 'other' });
    second.createdAt = '2026-02-01T00:00:00.000Z';
    second.status = 'failed';
    await saveRunRecord(second);

    const runs = await listProjectRuns(project);
    assert.deepEqual(runs.map((run) => run.id), ['run-new', 'run-old']);
    assert.equal((await findAppliedArchiveRun(project, 'same')).id, 'run-old');
    assert.equal(await findAppliedArchiveRun(project, 'missing'), null);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});
