import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { ZipflowClient } from '../src/client/zipflow-client.js';
import { resolveServerPaths } from '../src/server/runtime-paths.js';
import { startZipflowServer } from '../src/server/server.js';
import { createZip } from '../test-support/helpers.js';

test('headless HTTP completes archive, checks, history, report, and rollback', {
  skip: process.platform === 'win32' ? 'Windows runtime security remains fail-closed.' : false,
}, async (t) => {
  const fixture = await workflowServerFixture(t);
  const client = fixture.client;
  const opened = await client.openProject({
    path: fixture.projectRoot,
    idempotencyKey: 'open-project-e2e',
  });
  const initialized = await client.performProjectSetupAction(opened.projectId, 'initialize-git', {}, {
    idempotencyKey: 'initialize-git-e2e',
  });
  assert.equal(initialized.ok, true);
  const gitignore = await client.performProjectSetupAction(opened.projectId, 'create-gitignore', {}, {
    idempotencyKey: 'create-gitignore-e2e',
  });
  assert.equal(gitignore.created, true);
  const prepared = await client.performProjectSetupAction(opened.projectId, 'prepare-initial-commit', {}, {
    idempotencyKey: 'prepare-initial-commit-e2e',
  });
  assert.equal(prepared.ok, true);
  const initialCommit = await client.performProjectSetupAction(opened.projectId, 'create-initial-commit', {
    message: 'Initial commit',
    paths: prepared.approvedPaths,
  }, {
    idempotencyKey: 'create-initial-commit-e2e',
  });
  assert.equal(initialCommit.ok, true);
  const workflow = await client.putWorkflow(opened.projectId, workflowDraft(fixture.projectRoot), {
    ifMatch: 0,
    idempotencyKey: 'put-workflow-e2e',
  });
  assert.equal(workflow.revision, 1);

  const archivePath = await createZip(path.join(fixture.root, 'result.zip'), {
    'created.txt': 'created through the local server\n',
  });
  const archive = await readFile(archivePath);
  const uploaded = await client.uploadZip(archive, {
    filename: 'result.zip',
    contentLength: archive.length,
    idempotencyKey: 'upload-archive-e2e',
  });
  const started = await client.startArchiveRun(opened.projectId, {
    kind: 'archive',
    blobId: uploaded.blobId,
    correlation: {
      producer: 'chatgpt-bridge',
      workflowId: 'workflow-e2e',
      requestId: 'request-e2e',
    },
  }, { idempotencyKey: 'start-archive-e2e' });
  assert.equal(started.status, 'running');

  const planReady = await driveArchiveToPlan(client, started.runId);
  const plan = await client.getPlan(started.runId, { limit: 10 });
  assert.equal(plan.items.some(({ path: itemPath }) => itemPath === 'created.txt'), true);
  const diff = await client.getDiff(started.runId, { path: 'created.txt', mode: 'unified' });
  assert.equal(diff.binary, false);
  assert.equal(diff.hunks.some(({ lines }) => lines.some(({ newText }) => newText.includes('local server'))), true);
  await assert.rejects(
    client.performAction(started.runId, 'approve-plan', {}, {
      ifMatch: Math.max(0, planReady.revision - 1),
      idempotencyKey: 'stale-approve-plan-e2e',
    }),
    (error) => error?.code === 'STALE_REVISION' && error.status === 409,
  );
  await assert.rejects(
    client.performAction(started.runId, 'execute-command', {}, {
      ifMatch: planReady.revision,
      idempotencyKey: 'arbitrary-action-e2e',
    }),
    (error) => error?.code === 'ACTION_NOT_AVAILABLE' && error.status === 409,
  );

  await client.performAction(started.runId, 'approve-plan', {}, {
    ifMatch: planReady.revision,
    idempotencyKey: 'approve-plan-e2e',
  }).catch((error) => {
    throw new Error(`Approve failed; server errors: ${fixture.errors.map(formatError).join(' | ')}`, {
      cause: error,
    });
  });
  const completed = await waitForRun(client, started.runId, ['completed']);
  assert.equal(await readFile(path.join(fixture.projectRoot, 'created.txt'), 'utf8'), 'created through the local server\n');
  const checkOutput = await client.getOutput(started.runId, { source: 'checks' });
  assert.match(checkOutput.items.map(({ text }) => text).join(''), /check-ok/);
  const replayedApproval = await client.performAction(started.runId, 'approve-plan', {}, {
    ifMatch: planReady.revision,
    idempotencyKey: 'approve-plan-e2e',
  });
  assert.equal(replayedApproval.replayed, true);
  assert.equal(replayedApproval.surface.kind, 'completed');

  const report = await client.getReport(started.runId);
  assert.equal(report.status, 'completed');
  assert.equal(report.plan.counts.created, 1);
  assert.equal(JSON.stringify(report).includes(fixture.projectRoot), false);
  const historyBeforeRollback = await client.getHistory(opened.projectId, { limit: 10 });
  assert.equal(historyBeforeRollback.items.some(({ runId }) => runId === started.runId), true);

  const completedSurface = await client.getSurface(started.runId);
  assert.equal(completedSurface.kind, 'completed');
  assert.equal(completedSurface.actions.some(({ id, enabled }) => id === 'rollback' && enabled), true);
  const confirmation = await client.performAction(started.runId, 'rollback', {}, {
    ifMatch: completedSurface.revision,
    idempotencyKey: 'prepare-rollback-e2e',
  });
  assert.equal(confirmation.surface.kind, 'rollback_confirm');
  await client.performAction(started.runId, 'rollback', {}, {
    ifMatch: confirmation.surface.revision,
    idempotencyKey: 'perform-rollback-e2e',
  });
  const rolledBack = await waitForRun(client, started.runId, ['rolled_back']);
  assert.equal(rolledBack.status, 'rolled_back');
  await assert.rejects(readFile(path.join(fixture.projectRoot, 'created.txt')), { code: 'ENOENT' });

  await assert.rejects(
    client.startCheckRun(opened.projectId, {
      command: 'echo arbitrary-command-input-is-forbidden',
    }, { idempotencyKey: 'raw-check-command-e2e' }),
    (error) => error?.code === 'ACTION_INPUT_INVALID',
  );
  const checkStarted = await client.startCheckRun(opened.projectId, {
    checkIds: ['configured-check'],
  }, { idempotencyKey: 'start-checks-e2e' });
  const checkRun = await waitForRun(client, checkStarted.runId, ['completed']);
  assert.equal(checkRun.kind, 'checks');
  const deployWorkflow = workflowDraft(fixture.projectRoot);
  deployWorkflow.deploy = {
    policy: 'ask',
    commandText: `${process.execPath} -e "process.stdout.write('deploy-ok\\\\n')"`,
    cwd: '.',
  };
  await client.putWorkflow(opened.projectId, deployWorkflow, {
    ifMatch: 1,
    idempotencyKey: 'enable-deploy-e2e',
  });
  const deployStarted = await client.startDeployRun(opened.projectId, {}, {
    idempotencyKey: 'start-deploy-e2e',
  });
  const deployRun = await waitForRun(client, deployStarted.runId, ['completed']);
  assert.equal(deployRun.kind, 'deploy');
  const deployOutput = await client.getOutput(deployStarted.runId, { source: 'deploy' });
  assert.match(deployOutput.items.map(({ text }) => text).join(''), /deploy-ok/);
  const finalHistory = await client.getHistory(opened.projectId, { limit: 10 });
  assert.deepEqual(
    new Set(finalHistory.items.map(({ status }) => status)),
    new Set(['completed', 'rolled_back']),
  );
  assert.equal(finalHistory.items.length, 3);
  assert.equal(completed.runId, started.runId);
});

test('headless HTTP preserves guarded autopilot while every project mutation stays a semantic action', {
  skip: process.platform === 'win32' ? 'Windows runtime security remains fail-closed.' : false,
}, async (t) => {
  const decisions = [];
  const fixture = await workflowServerFixture(t, {
    loadRuntimeSettings: async () => ({
      llmProvider: 'lmstudio',
      llmModel: 'fixture-model',
      llmArchiveReview: 'disabled',
      llmUseArchiveReview: false,
      llmUseDeletionIntentReview: false,
      llmUseSummary: false,
      llmUseCommitMessage: false,
      managedHistoryPolicy: 'enabled',
    }),
    requestAutonomyDecision: async (request) => {
      decisions.push(request);
      assert.equal(request.gate, 'plan-application');
      assert.equal(request.allowedActions.includes('apply'), true);
      return {
        schemaVersion: 1,
        gate: request.gate,
        action: 'apply',
        targetId: null,
        confidence: 0.95,
        effectiveConfidence: 0.87,
        summary: 'The deterministic plan is routine and reversible.',
        evidence: ['One new file is present in the plan.'],
        risks: [],
        conditions: [],
        accepted: true,
        stateHash: 'fixture-state',
        repaired: false,
        provider: 'lmstudio',
        model: 'fixture-model',
      };
    },
  });
  const client = fixture.client;
  const opened = await client.openProject({
    path: fixture.projectRoot,
    idempotencyKey: 'autopilot-open-project-e2e',
  });
  const draft = workflowDraft(fixture.projectRoot);
  draft.checks = [];
  draft.autonomy = {
    mode: 'guarded',
    profileVersion: 1,
    maxDecisionRetries: 1,
    maxCheckRetries: 1,
    maxDeployRetries: 1,
    fullWarningAcknowledgedVersion: 0,
    capabilities: {
      decidePlanApplication: true,
      decideConflicts: false,
      decideFailedChecks: true,
      decideResultCommit: true,
      decideCommitRewrite: false,
      decideDeployment: true,
      allowCommitAfterFailedChecks: false,
      allowDeployAfterFailedChecks: false,
      allowRewriteUnpublishedCommits: false,
    },
  };
  await client.putWorkflow(opened.projectId, draft, {
    ifMatch: 0,
    idempotencyKey: 'autopilot-workflow-e2e',
  });
  const archivePath = await createZip(path.join(fixture.root, 'autopilot.zip'), {
    'autopilot.txt': 'applied by guarded autopilot\n',
  });
  const archive = await readFile(archivePath);
  const blob = await client.uploadZip(archive, {
    filename: 'autopilot.zip',
    contentLength: archive.length,
    idempotencyKey: 'autopilot-upload-e2e',
  });
  const started = await client.startArchiveRun(opened.projectId, {
    kind: 'archive',
    blobId: blob.blobId,
  }, { idempotencyKey: 'autopilot-start-e2e' });

  await waitForRun(client, started.runId, ['completed']);
  assert.equal(
    await readFile(path.join(fixture.projectRoot, 'autopilot.txt'), 'utf8'),
    'applied by guarded autopilot\n',
  );
  const report = await client.getReport(started.runId);
  assert.equal(report.decisions.length, 1);
  assert.equal(report.decisions[0].gate, 'plan-application');
  assert.equal(report.decisions[0].action, 'apply');
  assert.equal(report.autonomy.mode, 'guarded');
  assert.equal(decisions.length, 1);
});

async function driveArchiveToPlan(client, runId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const surface = await client.getSurface(runId);
    if (surface.kind === 'plan_review') return surface;
    if (surface.kind === 'archive_root_choice') {
      const choice = surface.sections.find(({ kind }) => kind === 'choice_list')?.choices?.[0];
      assert.ok(choice?.id);
      await client.performAction(runId, 'select-archive-root', { rootId: choice.id }, {
        ifMatch: surface.revision,
        idempotencyKey: `root-${surface.revision}`,
      });
    } else if (surface.kind === 'archive_safety') {
      await client.performAction(runId, 'acknowledge-archive-safety', {}, {
        ifMatch: surface.revision,
        idempotencyKey: `safety-${surface.revision}`,
      });
    } else if (surface.kind === 'conflict_summary') {
      const conflicts = surface.sections.find(({ kind }) => kind === 'conflict')?.conflicts ?? [];
      assert.ok(conflicts.length);
      let revision = surface.revision;
      for (const conflict of conflicts) {
        const resolved = await client.performAction(runId, 'resolve-conflict', {
          path: conflict.path,
          decision: 'archive',
        }, {
          ifMatch: revision,
          idempotencyKey: `conflict-${revision}-${conflict.id}`,
        });
        revision = resolved.surface.revision;
      }
    } else if (surface.kind === 'error') {
      assert.fail(`Archive inspection failed: ${JSON.stringify(surface)}`);
    }
    await delay(15);
  }
  assert.fail('Archive plan did not become ready before timeout.');
}

async function waitForRun(client, runId, statuses) {
  const expected = new Set(statuses);
  const deadline = Date.now() + 15_000;
  let current = null;
  while (Date.now() < deadline) {
    current = await client.getRun(runId);
    if (expected.has(current.status)) return current;
    if (['failed', 'uncertain', 'cancelled'].includes(current.status)) {
      assert.fail(`Run ${runId} stopped as ${current.status}: ${JSON.stringify(current)}`);
    }
    await delay(15);
  }
  assert.fail(`Run ${runId} stayed ${current?.status ?? 'unknown'} before timeout.`);
}

async function workflowServerFixture(t, {
  loadRuntimeSettings = undefined,
  requestAutonomyDecision = undefined,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-workflow-http-e2e-'));
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const socketPath = path.join(root, 'endpoint', 'server.sock');
  await mkdir(projectRoot, { recursive: true });
  const previousHome = process.env.ZIPFLOW_HOME;
  process.env.ZIPFLOW_HOME = home;
  const errors = [];
  const inspectProject = async (target) => ({
    root: await realpath(target),
    name: 'phase-3-fixture',
    git: null,
    checks: [],
    technologies: [],
    workspaceTechnologies: [],
    labels: [],
    workspaceLabels: [],
  });
  const server = await startZipflowServer({
    paths: resolveServerPaths({ zipflowHome: home, socketPath }),
    token: 'phase-3-e2e-token',
    inspectProject,
    ...(loadRuntimeSettings ? { loadRuntimeSettings } : {}),
    ...(requestAutonomyDecision ? { requestAutonomyDecision } : {}),
    onError: (error) => errors.push(error),
  });
  t.after(async () => {
    await server.application.waitForIdle();
    await server.close().catch(() => {});
    if (previousHome === undefined) delete process.env.ZIPFLOW_HOME;
    else process.env.ZIPFLOW_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    projectRoot,
    server,
    errors,
    client: new ZipflowClient({ socketPath, token: 'phase-3-e2e-token' }),
  };
}

function workflowDraft(projectPath) {
  return {
    version: 9,
    name: 'phase-3-workflow',
    projectPath,
    checks: [{
      id: 'configured-check',
      name: 'Configured check',
      kind: 'command',
      command: [process.execPath, '-e', 'process.stdout.write("check-ok\\n")'],
      selected: true,
      required: true,
      cwd: '.',
    }],
    exclude: [],
    archive: { mode: 'overlay', stripSingleRootDirectory: true },
    deletion: { scope: 'tracked-only' },
    policy: { conflictPolicy: 'ask', confirmPlan: true, failedChecks: 'ask' },
    git: { checkpoint: 'never', resultCommit: 'never', hooks: 'disabled' },
    deploy: { policy: 'disabled', commandText: '', cwd: '.' },
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatError(error) {
  const current = `${error?.name ?? 'Error'}:${error?.code ?? 'none'}:${error?.message ?? String(error)}`;
  return error?.cause ? `${current} <- ${formatError(error.cause)}` : current;
}
