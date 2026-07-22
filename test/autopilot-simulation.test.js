import test from 'node:test';
import assert from 'node:assert/strict';
import {
  historicalAutopilotScenarios,
  simulateHistoricalAutopilotRun,
} from '../src/app/settings-autopilot-replay.js';

test('historical autopilot simulation compares guarded and full modes without mutating the run', async () => {
  const run = fixtureRun();
  const snapshot = structuredClone(run);
  const calls = [];
  const result = await simulateHistoricalAutopilotRun({
    run,
    settings: { llmProvider: 'lmstudio', llmModel: 'fixture' },
    requestDecision: async ({ mode, gate, allowedActions }) => {
      calls.push({ mode, gate, allowedActions: [...allowedActions] });
      const preferred = gate === 'deployment' ? 'run'
        : gate === 'failed-checks' && allowedActions.includes('commit-anyway') ? 'commit-anyway'
          : gate === 'result-commit' ? 'create-new'
            : gate === 'conflicts' ? 'use-archive' : allowedActions[0];
      return {
        gate, action: preferred, targetId: null, confidence: 0.95, effectiveConfidence: 0.95,
        accepted: true, summary: `${mode} chose ${preferred}`, evidence: ['fixture'], risks: [], conditions: [],
      };
    },
  });

  assert.deepEqual(run, snapshot);
  assert.equal(result.modes.guarded.decisions.find((item) => item.gate === 'conflicts').action, 'ask-user');
  assert.equal(result.modes.full.decisions.find((item) => item.gate === 'conflicts').action, 'use-archive');
  assert.equal(result.modes.guarded.decisions.find((item) => item.gate === 'deployment').action, 'skip');
  assert.equal(result.modes.full.decisions.find((item) => item.gate === 'deployment').action, 'run');
  assert.ok(!calls.some((item) => item.mode === 'guarded' && item.gate === 'conflicts'));
  assert.ok(!calls.some((item) => item.mode === 'guarded' && item.gate === 'deployment'));
  assert.ok(calls.find((item) => item.mode === 'full' && item.gate === 'failed-checks').allowedActions.includes('commit-anyway'));
  assert.ok(!calls.find((item) => item.mode === 'guarded' && item.gate === 'failed-checks').allowedActions.includes('commit-anyway'));
});

test('low-confidence model proposals are shown as ask-user fallbacks', async () => {
  const run = fixtureRun({ conflicts: false, failedChecks: false, deploy: false });
  const result = await simulateHistoricalAutopilotRun({
    run,
    settings: {},
    requestDecision: async ({ gate }) => ({
      gate, action: gate === 'result-commit' ? 'create-new' : 'apply', targetId: null,
      confidence: 0.4, effectiveConfidence: 0.4, accepted: false,
      summary: 'Not confident enough', evidence: [], risks: ['ambiguous'], conditions: [],
    }),
  });
  for (const mode of ['guarded', 'full']) {
    assert.ok(result.modes[mode].decisions.every((item) => item.action === 'ask-user'));
    assert.ok(result.modes[mode].decisions.every((item) => item.source === 'confidence-fallback'));
  }
});

test('scenario reconstruction includes only gates supported by historical state', () => {
  const run = fixtureRun({ conflicts: false, failedChecks: false, deploy: false });
  assert.deepEqual(historicalAutopilotScenarios(run, 'guarded').map((item) => item.gate), [
    'plan-application', 'result-commit',
  ]);
});

test('scenario reconstruction ignores null and malformed historical decision entries', () => {
  const run = fixtureRun({ conflicts: true, failedChecks: true, deploy: true });
  run.autonomy = { decisions: null };
  run.decisions = [null, 'legacy', { gate: 'plan-application', action: 'apply' }];
  run.plan.conflicts = [null, { path: 'src/a.js', kind: 'modified' }];
  run.checks.results = [null, { name: 'Tests', ok: false, stderr: 'failed' }];

  const scenarios = historicalAutopilotScenarios(run, 'full');
  const plan = scenarios.find((item) => item.gate === 'plan-application');
  const conflicts = scenarios.find((item) => item.gate === 'conflicts');
  const checks = scenarios.find((item) => item.gate === 'failed-checks');

  assert.equal(plan.context.state.previousDecision.gate, 'plan-application');
  assert.deepEqual(conflicts.context.state.conflicts[0], { path: null, kind: null, reason: null });
  assert.equal(checks.context.state.checks.results.length, 1);
});

function fixtureRun({ conflicts = true, failedChecks = true, deploy = true } = {}) {
  return {
    id: 'run-history-1', archivePath: '/tmp/update.zip', createdAt: '2026-07-22T10:00:00.000Z',
    plan: {
      counts: { created: 1, updated: 2, deleted: 0, conflicts: conflicts ? 1 : 0 },
      created: ['src/new.js'], updated: ['src/a.js', 'src/b.js'], deleted: [],
      conflicts: conflicts ? [{ path: 'src/a.js', kind: 'modified', reason: 'local changes' }] : [],
    },
    applied: { paths: ['src/new.js', 'src/b.js'] },
    checks: failedChecks
      ? { ok: false, passed: 1, failed: 1, results: [{ name: 'Tests', ok: false, stderr: 'failed' }] }
      : { ok: true, passed: 2, failed: 0, results: [{ name: 'Tests', ok: true }] },
    commit: { created: true, hash: 'abc123', message: 'Apply update' },
    deploy: deploy ? { ok: false, commandText: 'npm run deploy', stderr: 'failed' } : null,
    decisions: [], autonomy: { decisions: [] },
  };
}
