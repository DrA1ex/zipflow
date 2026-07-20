import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunRecord, saveRunRecord } from '../src/runs/store.js';
import { evaluateArchiveRisks } from '../src/archive/risk.js';
import { tempDir } from '../test-support/helpers.js';

async function withHome(run) {
  const previous = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = await tempDir('zipflow-risk-home-');
  try { await run(); } finally {
    if (previous === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previous;
  }
}

function items(count, prefix) {
  return Array.from({ length: count }, (_, index) => ({ path: `${prefix}/${index}.js` }));
}

test('snapshot risk detects an older archive, large deletion, and a much smaller file set', async () => withHome(async () => {
  const projectPath = await tempDir('zipflow-risk-project-');
  const project = { root: projectPath, name: 'fixture' };
  const workflow = { name: 'fixture', archive: { mode: 'snapshot' } };
  const previous = await createRunRecord({
    id: 'risk-previous', project, workflow, archivePath: '/tmp/previous.zip',
    archiveInfo: { fileCount: 100, modifiedAt: '2026-07-20T12:00:00.000Z' },
  });
  previous.status = 'completed';
  previous.createdAt = '2026-07-20T12:01:00.000Z';
  await saveRunRecord(previous);

  const result = await evaluateArchiveRisks({
    projectPath,
    workflow,
    archiveInfo: { modifiedAt: '2026-07-19T10:00:00.000Z' },
    extracted: { fileCount: 35 },
    plan: {
      created: items(2, 'created'), updated: items(8, 'updated'), unchanged: items(20, 'same'), deleted: items(30, 'deleted'),
    },
  });

  assert.equal(result.previousRunId, 'risk-previous');
  assert.deepEqual(result.warnings.map((item) => item.id).sort(), [
    'large-deletion', 'older-than-last', 'smaller-than-last',
  ]);
  assert.equal(result.warnings.find((item) => item.id === 'large-deletion').severity, 'danger');
  assert.equal(result.warnings.find((item) => item.id === 'smaller-than-last').severity, 'danger');
}));

test('overlay archives never receive snapshot shrink warnings', async () => withHome(async () => {
  const projectPath = await tempDir('zipflow-risk-overlay-');
  const result = await evaluateArchiveRisks({
    projectPath,
    workflow: { archive: { mode: 'overlay' } },
    archiveInfo: { modifiedAt: '2026-07-20T12:00:00.000Z' },
    extracted: { fileCount: 1 },
    plan: { created: [], updated: [], unchanged: [], deleted: items(50, 'deleted') },
  });
  assert.deepEqual(result.warnings, []);
}));
