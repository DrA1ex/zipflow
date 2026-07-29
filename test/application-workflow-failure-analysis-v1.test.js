import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicWorkflowFailureAnalysis,
  runWorkflowFailureAnalysis,
  workflowFailureAnalysisEnabled,
} from '../src/application/workflow-failure-analysis-runner.js';

test('server failed-check analysis reuses the configured local LLM task without blocking recovery', async () => {
  const privateState = failureState();
  assert.equal(workflowFailureAnalysisEnabled(privateState), true);
  const analysis = await runWorkflowFailureAnalysis({
    project: { root: '/private/project', name: 'Fixture' },
    privateState,
    explainFailure: async ({ failedCheck }) => {
      assert.equal(failedCheck.id, 'lint');
      return {
        text: 'ERROR EXPLANATION:\nThe fixture failed.\nLIKELY CAUSE:\nA mismatch.\nNEXT STEPS:\n- Review it.',
        mode: 'same-context',
        provider: 'lmstudio',
        model: 'fixture-model',
      };
    },
  });
  const publicValue = publicWorkflowFailureAnalysis(analysis);
  assert.equal(publicValue.status, 'completed');
  assert.match(publicValue.text, /ERROR EXPLANATION/);
  assert.equal(JSON.stringify(publicValue).includes('/private/'), false);
});

test('server failed-check analysis failure remains a bounded advisory result', async () => {
  const analysis = await runWorkflowFailureAnalysis({
    project: { root: '/private/project', name: 'Fixture' },
    privateState: failureState(),
    explainFailure: async () => {
      throw new Error('model failed at /private/model');
    },
  });
  const publicValue = publicWorkflowFailureAnalysis(analysis);
  assert.equal(publicValue.status, 'failed');
  assert.equal(publicValue.error, 'model failed at [redacted-path]');
});

function failureState() {
  return {
    settings: {
      llmProvider: 'lmstudio',
      llmModel: 'fixture-model',
      llmUseFailedChecks: true,
      llmFailureAnalysis: 'same-context',
    },
    checks: {
      ok: false,
      results: [{
        id: 'lint',
        name: 'Lint',
        ok: false,
        stdout: '',
        stderr: 'fixture failed',
      }],
    },
    llm: { contextText: 'Previous archive summary.' },
  };
}
