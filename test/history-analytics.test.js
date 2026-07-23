import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunAnalytics } from '../src/history/analytics.js';

function run(createdAt, checkMs, llmMs, { checkOk = true, llmError = null, model = 'gemma', truncated = false, attempts = 1 } = {}) {
  return {
    createdAt,
    checks: {
      ok: checkOk,
      results: [
        { name: 'Unit tests', durationMs: checkMs, ok: checkOk },
        { name: 'Lint', durationMs: Math.round(checkMs / 2), ok: true },
      ],
    },
    llm: {
      durationMs: llmMs, provider: 'lmstudio', model, error: llmError,
      diagnostics: { attempts: Array.from({ length: attempts }, (_, index) => ({ attempt: index + 1, patch: { truncated } })) },
    },
  };
}

test('history analytics calculate per-check and per-model medians, success, retries, and trends', () => {
  const runs = [
    run('2026-07-06', 2000, 6000, { truncated: true, attempts: 2 }),
    run('2026-07-05', 2200, 6200),
    run('2026-07-04', 2400, 6400),
    run('2026-07-03', 1000, 3000),
    run('2026-07-02', 1100, 3200, { checkOk: false, llmError: 'failed' }),
    run('2026-07-01', 1200, 3400),
  ];
  const analytics = buildRunAnalytics(runs);

  assert.equal(analytics.runCount, 6);
  const unit = analytics.checks.byName.find((item) => item.name === 'Unit tests');
  assert.equal(unit.count, 6);
  assert.equal(unit.medianMs, 1200);
  assert.equal(unit.successRate, 5 / 6);
  assert.match(unit.trend, /slower recently/);

  const model = analytics.llm.byModel.find((item) => item.name === 'lmstudio · gemma');
  assert.equal(model.count, 6);
  assert.equal(model.truncated, 1);
  assert.equal(model.averageAttempts, 7 / 6);
  assert.equal(analytics.llm.truncated, 1);
  assert.equal(analytics.llm.averageAttempts, 7 / 6);
  assert.equal(analytics.llm.total.successRate, 5 / 6);
  assert.match(model.trend, /slower recently/);
});

test('empty history returns stable zero-value summaries', () => {
  const analytics = buildRunAnalytics([]);
  assert.equal(analytics.runCount, 0);
  assert.equal(analytics.checks.total.medianMs, 0);
  assert.equal(analytics.llm.total.trend, 'not enough history');
  assert.deepEqual(analytics.llm.byModel, []);
});
