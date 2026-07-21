import test from 'node:test';
import assert from 'node:assert/strict';
import { autonomyForMode, canAutonomy, confidenceThreshold } from '../src/autonomy/policies.js';
import { calculateEffectiveConfidence, parseDecision } from '../src/autonomy/decision-engine.js';
import { decideAtGate, resumeAutopilot } from '../src/app/autonomy-flow.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { tempDir } from '../test-support/helpers.js';

test('autonomy profiles expose bounded capabilities and distinct confidence thresholds', () => {
  const guarded = { autonomy: autonomyForMode('guarded') };
  const full = { autonomy: autonomyForMode('full') };
  assert.equal(canAutonomy(guarded, 'decideFailedChecks'), true);
  assert.equal(canAutonomy(guarded, 'decideCommitRewrite'), false);
  assert.equal(canAutonomy(full, 'decideCommitRewrite'), true);
  assert.equal(full.autonomy.capabilities.allowDeployAfterFailedChecks, true);
  assert.equal(guarded.autonomy.capabilities.allowDeployAfterFailedChecks, false);
  assert.ok(confidenceThreshold('guarded') > confidenceThreshold('full'));
});

test('autonomous decision parsing rejects actions outside the application allowlist', () => {
  const value = JSON.stringify({
    schemaVersion: 1, gate: 'deployment', action: 'run-shell', targetId: null,
    confidence: 1, summary: 'Run an invented command.', evidence: [], risks: [], conditions: [],
  });
  assert.equal(parseDecision(value, 'deployment', ['run', 'skip', 'ask-user']), null);
});

test('effective confidence is reduced for risky, incomplete, low-coverage decisions', () => {
  const safe = calculateEffectiveConfidence(0.9, { riskLevel: 'low', complete: true });
  const risky = calculateEffectiveConfidence(0.9, {
    riskLevel: 'high', complete: false, ambiguous: true,
    coverage: { patchCoveragePercent: 20 },
  });
  assert.equal(safe, 0.9);
  assert.ok(risky < 0.5);
});

test('accepted autonomous decisions are audited and low-confidence proposals return control to the user', async () => {
  const home = await tempDir('zipflow-autonomy-home-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const state = fixtureState('guarded');
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};
    const decision = await decideAtGate(controller, {
      gate: 'plan-application', capability: 'decidePlanApplication',
      context: { state: { plan: 'safe' }, riskLevel: 'low', complete: true },
      allowedActions: ['apply', 'abort', 'ask-user'], fallback: 'ask-user',
      requestDecision: async () => ({
        action: 'apply', targetId: null, confidence: 0.95, effectiveConfidence: 0.95,
        accepted: true, stateHash: 'before', repaired: false, provider: 'ollama', model: 'fixture',
        summary: 'The deterministic plan is conflict-free.', evidence: ['No deletions'], risks: [], conditions: [],
      }),
    });
    assert.equal(decision.action, 'apply');
    assert.equal(state.run.decisions.length, 1);
    assert.equal(state.run.decisions[0].gate, 'plan-application');

    const low = await decideAtGate(controller, {
      gate: 'deployment', capability: 'decideDeployment',
      context: { state: {}, riskLevel: 'high', complete: false },
      allowedActions: ['run', 'skip', 'ask-user'], fallback: 'skip',
      requestDecision: async () => ({
        action: 'run', targetId: null, confidence: 0.4, effectiveConfidence: 0.2,
        accepted: false, stateHash: 'same', repaired: false, provider: 'ollama', model: 'fixture',
        summary: 'Evidence is incomplete.', evidence: [], risks: ['Checks unavailable'], conditions: [],
      }),
    });
    assert.equal(low.action, 'ask-user');
    assert.equal(state.run.decisions.at(-1).proposedAction, 'run');
    assert.equal(state.run.decisions.at(-1).action, 'ask-user');
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

test('cancelling an LLM decision pauses autonomy until explicitly resumed', async () => {
  const home = await tempDir('zipflow-autonomy-cancel-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const state = fixtureState('full');
    const controller = new ZipflowController(state);
    controller.invalidate = () => {};
    const result = await decideAtGate(controller, {
      gate: 'failed-checks', capability: 'decideFailedChecks',
      context: { state: {}, riskLevel: 'high', complete: true },
      allowedActions: ['rollback', 'ask-user'], fallback: 'ask-user',
      requestDecision: async () => { const error = new Error('cancelled'); error.code = 'cancelled'; throw error; },
    });
    assert.equal(result.action, 'ask-user');
    assert.equal(state.run.autonomy.paused, true);
    await resumeAutopilot(controller);
    assert.equal(state.run.autonomy.paused, false);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

function fixtureState(mode) {
  const state = createInitialState();
  state.project = { root: '/tmp/project', name: 'project', git: null, technologies: [], labels: [], checks: [] };
  state.workflow = {
    autonomy: autonomyForMode(mode),
    checks: [], git: { resultCommit: 'ask' }, deploy: { policy: 'disabled' },
  };
  state.settings = { llmProvider: 'ollama', llmModel: 'fixture' };
  state.runSettings = Object.freeze({ llmProvider: 'ollama', llmModel: 'fixture' });
  state.run = {
    id: 'run-autonomy', status: 'planned', projectPath: '/tmp/project', decisions: [],
    autonomy: { mode, paused: false, decisions: [], fallbackCount: 0, checkRetries: 0, deployRetries: 0 },
  };
  return state;
}
