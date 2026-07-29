import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  publicWorkflowLlmReview,
  runWorkflowLlmReview,
  workflowLlmReviewEnabled,
} from '../src/application/workflow-llm-review-runner.js';

test('server workflow review reuses the local LLM pipeline and publishes only bounded advisory data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-server-llm-review-'));
  const patchPath = path.join(root, 'changes.patch');
  await writeFile(patchPath, 'diff --git a/src/a.js b/src/a.js\n-old\n+new\n');
  const settings = {
    llmProvider: 'lmstudio',
    llmModel: 'fixture-model',
    llmArchiveReview: 'structure',
    llmUseArchiveReview: true,
    llmUseDeletionIntentReview: false,
    llmUseSummary: true,
    llmUseCommitMessage: true,
  };
  const privateState = {
    settings,
    workflow: { archive: { mode: 'overlay' } },
    plan: {
      counts: { created: 0, updated: 1, deleted: 0, unchanged: 0 },
      created: [],
      updated: [{ path: 'src/a.js' }],
      deleted: [],
    },
    extracted: { root: path.join(root, 'extracted') },
    patch: { path: patchPath },
    safety: { warnings: [], acknowledged: true },
  };
  const calls = [];

  try {
    assert.equal(workflowLlmReviewEnabled(privateState), true);
    const reviewed = await runWorkflowLlmReview({
      runId: 'run-1',
      project: { root, name: 'Fixture' },
      privateState,
      resolveSession: async () => ({
        profile: { contextLength: 16_384, requestModel: 'fixture-model' },
        apiToken: '',
      }),
      reviewStructure: async () => ({
        assessment: 'suitable',
        confidence: 'high',
        reasons: ['Archive matches the project.'],
        recommendation: 'continue',
        diagnostics: { privatePath: root },
      }),
      generateDescription: async ({ patchContent }) => {
        calls.push(patchContent);
        return {
          summary: ['Updated the fixture.'],
          commitMessage: 'Update fixture',
          diagnostics: { delivery: { resolved: 'patch' } },
        };
      },
      saveDiagnostics: async () => path.join(root, 'private-diagnostics.json'),
    });

    assert.equal(calls[0].includes('+new'), true);
    assert.equal(reviewed.record.commitMessage, 'Update fixture');
    assert.equal(reviewed.assessment.assessment, 'suitable');
    const publicReview = publicWorkflowLlmReview(
      reviewed.record,
      reviewed.assessment,
      reviewed.deletionIntent,
    );
    assert.deepEqual(publicReview.summary, ['Updated the fixture.']);
    assert.equal(publicReview.assessment.recommendation, 'continue');
    assert.equal(JSON.stringify(publicReview).includes(root), false);
    assert.equal(Object.hasOwn(publicReview, 'diagnostics'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server workflow review failure remains advisory and does not expose provider diagnostics', async () => {
  const privateState = {
    settings: {
      llmProvider: 'lmstudio',
      llmModel: 'fixture-model',
      llmArchiveReview: 'patch',
      llmUseArchiveReview: true,
      llmUseSummary: true,
      llmUseCommitMessage: true,
    },
    workflow: { archive: { mode: 'overlay' } },
    plan: {
      counts: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
      created: [{ path: 'src/a.js' }],
      updated: [],
      deleted: [],
    },
    extracted: { root: '/private/extracted' },
    patch: null,
    safety: { warnings: [], acknowledged: true },
  };
  const reviewed = await runWorkflowLlmReview({
    runId: 'run-2',
    project: { root: '/private/project', name: 'Fixture' },
    privateState,
    resolveSession: async () => ({ profile: { contextLength: 8_192 }, apiToken: '' }),
    generateDescription: async () => {
      throw new Error('provider unavailable at /private/model');
    },
    saveDiagnostics: async () => '/private/diagnostics.json',
  });
  const publicReview = publicWorkflowLlmReview(reviewed.record, null, null);

  assert.equal(publicReview.status, 'failed');
  assert.equal(publicReview.error, 'provider unavailable at [redacted-path]');
  assert.equal(Object.hasOwn(publicReview, 'diagnosticsPath'), false);
});
