import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  assertManifestDiffPath,
  MAX_HISTORY_PAGE_SIZE,
  MAX_OUTPUT_RESPONSE_BYTES,
  projectDiffResource,
  projectHistoryResource,
  projectOutputResource,
  projectPlanResource,
  projectReportResource,
  projectRunResource,
} from '../src/server/run-resource-projections.js';
import {
  createRunSessionRecord,
  validateRunSessionRecord,
} from '../src/server/run-session-model.js';

test('run and plan projections never expose private manifest paths', () => {
  const session = recordFixture({ fileCount: 3 });
  session.publicSummary.title = `\u001b[31mReview ${session.binding.projectPath}\u001b[0m`;
  session.publicSummary.projectPath = session.binding.projectPath;
  session.publicSummary.currentPath = session.executionManifest.created[0].currentPath;
  const run = projectRunResource(session);
  const first = projectPlanResource(session, { group: 'created', limit: 1 });
  const second = projectPlanResource(session, { group: 'created', limit: 1, cursor: first.page.nextCursor });
  const serialized = JSON.stringify({ run, first, second });

  assert.equal(run.revision, 1);
  assert.equal(run.summary.title, 'Review [redacted-path]');
  assert.equal(Object.hasOwn(run.summary, 'projectPath'), false);
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.ok(first.page.nextCursor && first.page.nextCursor !== '1');
  assert.deepEqual([...first.items, ...second.items].map(({ path: itemPath }) => itemPath), ['src/file-0.js', 'src/file-1.js']);
  assert.doesNotMatch(serialized, /sourcePath|currentPath|projectPath|\u001b/);
  assert.doesNotMatch(serialized, new RegExp(escapeRegex(session.binding.projectPath)));
  assert.doesNotMatch(serialized, new RegExp(escapeRegex(session.executionManifest.created[0].sourcePath)));

  const nested = recordFixture();
  nested.publicSummary = {
    project: { name: 'Nested project' }, workflow: { name: 'Nested workflow' },
    plan: { counts: { created: 1 } }, archive: { filename: '/private/inbox/nested.zip' },
  };
  const nestedRun = projectRunResource(nested);
  assert.equal(nestedRun.summary.projectName, 'Nested project');
  assert.equal(nestedRun.summary.workflowName, 'Nested workflow');
  assert.equal(nestedRun.summary.archiveName, 'nested.zip');

  assert.throws(
    () => projectPlanResource(session, { group: 'updated', cursor: first.page.nextCursor }),
    (error) => error?.code === 'INVALID_CURSOR',
  );
  const tampered = `${first.page.nextCursor.slice(0, -1)}${first.page.nextCursor.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(
    () => projectPlanResource(session, { group: 'created', cursor: tampered }),
    (error) => error?.code === 'INVALID_CURSOR',
  );
});

test('history pagination is opaque, filtered, stable, and capped by the server', () => {
  const sessions = Array.from({ length: 125 }, (_, index) => recordFixture({
    runId: `run-history-${String(index).padStart(3, '0')}`,
    projectId: 'project-history',
    status: index % 2 ? 'completed' : 'failed',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  sessions.push(recordFixture({ runId: 'run-other-project', projectId: 'project-other' }));
  const first = projectHistoryResource(sessions, { projectId: 'project-history', limit: 10_000 });
  assert.equal(first.items.length, MAX_HISTORY_PAGE_SIZE);
  assert.equal(first.page.total, 125);
  assert.ok(first.page.nextCursor);
  const second = projectHistoryResource(sessions, {
    projectId: 'project-history', limit: 10_000, cursor: first.page.nextCursor,
  });
  assert.equal(second.items.length, 25);
  assert.equal(second.page.nextCursor, null);
  assert.ok(first.items[0].createdAt > first.items.at(-1).createdAt);
  assert.doesNotMatch(JSON.stringify(first), /\/private\/project|sourcePath|currentPath/);

  const failed = projectHistoryResource(sessions, { projectId: 'project-history', status: 'failed', limit: 5 });
  assert.equal(failed.items.length, 5);
  assert.ok(failed.items.every(({ status }) => status === 'failed'));
  assert.throws(
    () => projectHistoryResource(sessions, { projectId: 'project-other', cursor: first.page.nextCursor }),
    (error) => error?.code === 'INVALID_CURSOR',
  );
});

test('output is ANSI-free, byte bounded, paginated, and keeps truncation metadata', () => {
  const session = recordFixture();
  session.outputs = [
    output(1, 'checks', `\u001b[31mFAIL\u001b[0m ${session.binding.projectPath} ${'x'.repeat(80)}`, true, 17),
    output(2, 'checks', 'second output'),
    output(3, 'checks', 'third output'),
    output(4, 'deploy', '\u001b[32mdeployed\u001b[0m'),
  ];
  const validated = validateRunSessionRecord(session, { stored: false });
  const first = projectOutputResource(validated, { source: 'checks', limit: 2, maxBytes: 64 });
  assert.equal(first.items.length, 2);
  assert.ok(first.items.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) <= 64);
  assert.equal(first.items[0].truncated, true);
  assert.ok(first.items[0].omittedBytes > 17);
  assert.doesNotMatch(JSON.stringify(first), /\u001b|\/private\/project/);

  const appended = structuredClone(validated);
  appended.revision += 1;
  appended.outputs.push(output(5, 'checks', 'appended after first page'));
  const second = projectOutputResource(appended, {
    source: 'checks', limit: 2, maxBytes: 64, cursor: first.page.nextCursor,
  });
  assert.deepEqual(second.items.map(({ sequence }) => sequence), [3, 5]);
  assert.equal(second.page.nextCursor, null);

  const hardBound = projectOutputResource(validated, {
    source: 'checks', limit: 1, maxBytes: MAX_OUTPUT_RESPONSE_BYTES * 10,
  });
  assert.equal(hardBound.maxBytes, MAX_OUTPUT_RESPONSE_BYTES);
  assert.throws(() => projectOutputResource(validated, { source: 'raw' }), (error) => error?.code === 'INVALID_OUTPUT_SOURCE');
});

test('diff path must be an exact changed manifest member and semantic lines contain no ANSI', () => {
  const session = recordFixture();
  const privateItem = assertManifestDiffPath(session, 'src/file-0.js');
  assert.equal(privateItem.currentPath, '/private/project/src/file-0.js');
  assert.throws(() => assertManifestDiffPath(session, '../src/file-0.js'), (error) => error?.code === 'INVALID_DIFF_PATH');
  assert.throws(() => assertManifestDiffPath(session, 'src/missing.js'), (error) => error?.code === 'DIFF_PATH_NOT_IN_MANIFEST');

  const projected = projectDiffResource(session, {
    path: 'src/file-0.js',
    diff: {
      binary: false,
      rows: [
        { type: 'same', oldNo: 1, newNo: 1, oldText: 'same', newText: 'same' },
        { type: 'remove', oldNo: 2, newNo: null, oldText: '\u001b[31mold /private/project/src/file-0.js\u001b[0m', newText: '' },
        { type: 'add', oldNo: null, newNo: 2, oldText: '', newText: '\u001b[32mnew /private/extracted/src/file-0.js\u001b[0m' },
      ],
    },
  });
  assert.equal(projected.hunks.length, 1);
  assert.equal(projected.hunks[0].lines[1].oldText, 'old [redacted-path]');
  assert.equal(projected.hunks[0].lines[2].newText, 'new [redacted-path]');
  assert.doesNotMatch(JSON.stringify(projected), /\u001b|\/private\/project|\/private\/extracted/);
});

test('report projection selectively sanitizes legacy report policy fields', () => {
  const session = recordFixture();
  const legacyRun = {
    version: 9,
    id: session.run.runId,
    projectPath: '/private/project',
    projectName: 'Fixture',
    workflowName: 'Workflow',
    archivePath: '/private/inbox/release.zip',
    archiveInfo: { size: 1234, fileCount: 7 },
    patch: { path: '/private/project/.zipflow/changes.patch' },
    plan: { counts: { created: 3, updated: 0, deleted: 0 } },
    checks: {
      ok: false, passed: 0, failed: 1, skipped: 0,
      results: [{ id: 'test', name: 'Tests', ok: false, cwd: '.', code: 1, stdout: '/private/project secret output' }],
    },
    deploy: {
      ok: false, policy: 'always', cwd: '.', commandText: 'deploy /private/project',
      stdout: '/private/project deployment output',
    },
    applied: { backupPath: '/private/project/.zipflow/backups/run' },
    llm: {
      provider: 'ollama',
      model: 'fixture',
      durationMs: 1250,
      assessment: 'suitable',
      summary: ['Updated /private/project safely'],
      contextText: 'private prompt must not be exposed',
      diagnosticsPath: '/private/project/.zipflow/private.json',
    },
    autonomy: { mode: 'guarded', paused: false, fallbackCount: 1, checkRetries: 2 },
    decisions: [{
      id: 'decision-1',
      gate: 'plan',
      action: 'approve-plan',
      proposedAction: 'approve-plan',
      executionStatus: 'failed',
      executionError: 'Project changed under /private/project',
      source: 'llm',
      model: 'fixture-model',
      confidence: 0.8,
      effectiveConfidence: 0.7,
      allowedActions: ['approve-plan', 'cancel-run'],
      evidence: ['Reviewed /private/project'],
      risks: ['Local overlap'],
      conditions: ['No drift'],
      accepted: true,
      stateDrift: true,
    }],
    archiveSafety: { warnings: [{ code: 'review', message: 'Review /private/project' }] },
    error: { code: 'FAILED', message: 'Could not read /private/extracted/src/file-0.js' },
  };
  const report = projectReportResource(session, { legacyRun });
  const serialized = JSON.stringify(report);
  assert.equal(report.archive.filename, 'archive.zip');
  assert.equal(report.archive.fileCount, 7);
  assert.deepEqual(report.plan.counts, { created: 1, updated: 0, deleted: 0 });
  assert.equal(report.deploy.commandText, 'deploy [redacted-path]');
  assert.equal(report.error.message, 'Could not read [redacted-path]');
  assert.equal(report.llm.model, 'fixture');
  assert.deepEqual(report.llm.summary, ['Updated [redacted-path] safely']);
  assert.equal(Object.hasOwn(report.llm, 'contextText'), false);
  assert.equal(report.autonomy.mode, 'guarded');
  assert.equal(report.decisions[0].model, 'fixture-model');
  assert.deepEqual(report.decisions[0].allowedActions, ['approve-plan', 'cancel-run']);
  assert.equal(report.decisions[0].executionError, 'Project changed under [redacted-path]');
  assert.equal(report.decisions[0].stateDrift, true);
  assert.equal(report.archiveSafety.warnings[0].message, 'Review [redacted-path]');
  assert.equal(report.applied.backupAvailable, true);
  assert.equal(Object.hasOwn(report.checks.results[0], 'stdout'), false);
  assert.doesNotMatch(serialized, /projectPath|archivePath|sourcePath|currentPath|backupPath|\/private\//);
});

function recordFixture({
  runId = 'run-fixture',
  projectId = 'project-fixture',
  status = 'waiting_action',
  createdAt = '2026-07-28T00:00:00.000Z',
  fileCount = 1,
} = {}) {
  const hash = 'c'.repeat(64);
  const files = Array.from({ length: fileCount }, (_, index) => ({
    kind: 'created',
    path: `src/file-${index}.js`,
    sourcePath: `/private/extracted/src/file-${index}.js`,
    currentPath: `/private/project/src/file-${index}.js`,
    beforeHash: null,
    afterHash: hash,
    mode: 0o644,
  }));
  return createRunSessionRecord({
    runId,
    binding: {
      projectId, projectPath: '/private/project', workflowRevision: 9,
      blobId: `sha256:${hash}`, blobSha256: hash,
    },
    kind: 'archive', status,
    correlation: { producer: 'chatgpt-bridge', workflowId: 'workflow-1', requestId: 'request-1', privatePath: '/private/project' },
    executionManifest: {
      created: files, updated: [], deleted: [], preserved: [], unchanged: [], skipped: [], conflicts: [],
      counts: { created: files.length, updated: 0, deleted: 0 },
    },
    publicSummary: {
      projectName: 'Fixture', workflowName: 'Workflow', archiveName: '/private/inbox/archive.zip',
      counts: { created: files.length, updated: 0, deleted: 0 },
    },
  }, createdAt);
}

function output(sequence, source, text, truncated = false, omittedBytes = 0) {
  return {
    sequence, source, stream: 'stdout', text, commandId: null, checkId: 'check-1',
    truncated, omittedBytes, createdAt: '2026-07-28T00:00:00.000Z',
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
