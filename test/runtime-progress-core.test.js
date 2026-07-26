import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatedProgress } from '../src/app/runtime-progress.js';
import { buildRunAnalytics } from '../src/history/analytics.js';

test('estimated runtime progress stays below completion until the operation finishes', () => {
  assert.deepEqual(estimatedProgress({ expectedMs: 0, elapsedMs: 5_000 }), {
    determinate: false, elapsedMs: 5_000, expectedMs: 0, value: 0, total: 1,
  });
  const known = estimatedProgress({ expectedMs: 10_000, elapsedMs: 50_000 });
  assert.equal(known.determinate, true);
  assert.equal(known.total, 10_000);
  assert.ok(known.value < known.total);
});

test('run analytics expose a deployment median for live progress estimates', () => {
  const analytics = buildRunAnalytics([
    { createdAt: '2026-01-01T00:00:00.000Z', deploy: { ok: true, durationMs: 5_000 } },
    { createdAt: '2026-01-02T00:00:00.000Z', deploy: { ok: true, durationMs: 9_000 } },
    { createdAt: '2026-01-03T00:00:00.000Z', deploy: { ok: false, durationMs: 7_000 } },
  ]);
  assert.equal(analytics.deployment.count, 3);
  assert.equal(analytics.deployment.medianMs, 7_000);
});
