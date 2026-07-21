import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { beginArchiveInput, submitRunEditor } from '../src/app/run-flow.js';
import { decideResultCommit } from '../src/app/run-autonomy.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { autonomyForMode } from '../src/autonomy/policies.js';
import { createRunRecord } from '../src/runs/store.js';
import { discoverProject } from '../src/project/detect.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';
import { createZip, initGit, tempDir, writeFiles } from '../test-support/helpers.js';

test('a no-change archive bypasses LLM, checks, apply, commit, and deployment', async () => {
  const home = await tempDir('zipflow-noop-home-');
  const root = await tempDir('zipflow-noop-project-');
  const archiveRoot = await tempDir('zipflow-noop-archive-');
  const archive = path.join(archiveRoot, 'same.zip');
  const storage = path.join(home, 'archive-storage');
  const originalFetch = globalThis.fetch;
  process.env.ZIPFLOW_HOME = home;
  try {
    const files = {
      'package.json': '{"name":"fixture"}\n',
      'src/index.js': 'export const value = 1;\n',
    };
    await writeFiles(root, files);
    await initGit(root);
    await createZip(archive, files);
    const project = await discoverProject(root);
    const workflow = createRecommendedWorkflow(project);
    workflow.autonomy = autonomyForMode('guarded');
    workflow.checks = [{ name: 'Must not run', command: 'node', args: ['-e', 'process.exit(9)'], selected: true, required: true }];
    workflow.git.resultCommit = 'ask';
    workflow.deploy = { policy: 'always', command: 'node', args: ['-e', 'process.exit(9)'], commandText: 'node -e process.exit(9)', cwd: '.' };

    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error('LLM must not be called for a no-change plan'); };

    const state = createInitialState();
    state.project = project;
    state.workflow = workflow;
    state.settings = {
      ...DEFAULT_SETTINGS,
      llmProvider: 'ollama', llmModel: 'fixture', llmArchiveReview: 'structure',
      archivePolicy: 'move', archiveDirectory: storage,
    };
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};
    beginArchiveInput(controller);
    state.editor.insert(archive);
    await submitRunEditor(controller);

    assert.equal(state.screen, 'archive-input');
    assert.equal(state.run.status, 'no_changes');
    assert.equal(state.run.patch, null);
    assert.equal(state.run.llm, null);
    assert.equal(state.run.checks, null);
    assert.equal(state.run.commit, null);
    assert.equal(state.run.deploy, null);
    assert.equal(fetchCalls, 0);
    assert.ok(state.messages.some((item) => item.title === 'Archive already matches the project'));
    assert.ok(state.messages.some((item) => item.title.startsWith('Update run ')));
    assert.equal(state.messages.some((item) => item.title === 'Local LLM analysis starting'), false);
    assert.equal(state.messages.some((item) => item.title === 'Checks starting'), false);
    assert.equal(state.messages.some((item) => item.title.includes('autopilot') && item.title.includes('decision')), false);
    assert.equal(state.run.archiveDisposition.action, 'moved');
    await access(state.run.archiveDisposition.path);
    const report = await readFile(path.join(home, 'runs', state.run.id, 'report.txt'), 'utf8');
    assert.match(report, /Status: no_changes/);
    await controller.cleanup();
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ZIPFLOW_HOME;
  }
});

test('result-commit autonomy receives exact committable applied-path context', async () => {
  const home = await tempDir('zipflow-commit-context-home-');
  const root = await tempDir('zipflow-commit-context-project-');
  process.env.ZIPFLOW_HOME = home;
  try {
    await writeFiles(root, {
      'package.json': '{"name":"fixture"}\n',
      'README.md': 'Before\n',
    });
    await initGit(root);
    await writeFile(path.join(root, 'README.md'), 'After\n');
    await writeFiles(root, { 'docs/guide.md': '# Guide\n' });

    const project = await discoverProject(root);
    const workflow = createRecommendedWorkflow(project);
    workflow.autonomy = autonomyForMode('guarded');
    workflow.git.resultCommit = 'ask';
    workflow.checks = [];
    const run = await createRunRecord({ id: 'commit-context-run', project, workflow, archivePath: '/tmp/update.zip' });
    run.status = 'checks_passed';
    run.applied = { paths: ['README.md', 'docs/guide.md'], changedPaths: ['README.md', 'docs/guide.md'] };
    run.checks = { ok: true, passed: 2, failed: 0, results: [] };

    const state = createInitialState();
    state.project = project;
    state.workflow = workflow;
    state.run = run;
    state.settings = { ...DEFAULT_SETTINGS, llmProvider: 'ollama', llmModel: 'fixture' };
    state.runSettings = Object.freeze({ ...state.settings });
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};
    let captured = null;
    const handled = await decideResultCommit(controller, {
      candidates: [{ id: 'llm', label: 'Local LLM', message: 'Document the update' }],
      createNew: async () => {}, amendHead: async () => {}, squash: async () => {}, skip: async () => {},
      requestDecision: async (input) => {
        captured = input;
        return {
          action: 'ask-user', targetId: null, confidence: 0.9, effectiveConfidence: 0.9,
          accepted: true, stateHash: 'before', repaired: false, provider: 'ollama', model: 'fixture',
          summary: 'The commit policy requires user confirmation.', evidence: [], risks: [], conditions: [],
        };
      },
    });

    assert.equal(handled, false);
    assert.deepEqual(captured.context.state.committableAppliedPaths.sort(), ['README.md', 'docs/guide.md']);
    assert.deepEqual(captured.context.state.appliedPathGitEntries.map((item) => item.path).sort(), ['README.md', 'docs/guide.md']);
    assert.equal(captured.context.state.appliedPathCount, 2);
    assert.equal(captured.context.state.recommendedAction, 'create-new');
    assert.match(captured.context.state.checkpointPurpose, /already-applied Zipflow update/);
    assert.ok(captured.context.state.validSkipReasons.every((item) => !/user command/i.test(item)));
    await controller.cleanup();
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});
