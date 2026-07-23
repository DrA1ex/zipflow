import { modelAnalyticsLabel } from '../llm/model-identity.js';
export function buildRunAnalytics(runs) {
  const completed = runs.filter((run) => run.checks || run.llm);
  return {
    runCount: completed.length,
    checks: checkAnalytics(completed),
    llm: llmAnalytics(completed),
  };
}

function checkAnalytics(runs) {
  const totals = runs.flatMap((run) => {
    const values = run.checks?.results ?? [];
    return values.length ? [{ durationMs: values.reduce((sum, item) => sum + (item.durationMs ?? 0), 0), ok: run.checks.ok }] : [];
  });
  const byName = new Map();
  for (const run of runs) {
    for (const check of run.checks?.results ?? []) {
      const values = byName.get(check.name) ?? [];
      values.push({ durationMs: check.durationMs ?? 0, ok: Boolean(check.ok), at: run.createdAt });
      byName.set(check.name, values);
    }
  }
  return {
    total: summarize(totals),
    byName: [...byName.entries()].map(([name, values]) => ({ name, ...summarize(values) }))
      .sort((left, right) => right.averageMs - left.averageMs),
  };
}

function llmAnalytics(runs) {
  const values = runs.flatMap((run) => run.llm?.durationMs ? [{
    durationMs: run.llm.durationMs,
    ok: !run.llm.error && !run.llm.cancelled,
    provider: run.llm.provider,
    model: run.llm.model,
    truncated: Boolean(run.llm.diagnostics?.attempts?.some((item) => item.patch?.truncated)),
    attempts: run.llm.diagnostics?.attempts?.filter((item) => typeof item.attempt === 'number').length ?? 1,
    at: run.createdAt,
  }] : []);
  const groups = new Map();
  for (const item of values) {
    const key = modelAnalyticsLabel(item.provider, item.model);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return {
    total: summarize(values),
    truncated: values.filter((item) => item.truncated).length,
    averageAttempts: values.length ? values.reduce((sum, item) => sum + item.attempts, 0) / values.length : 0,
    byModel: [...groups.entries()].map(([name, group]) => ({
      name,
      ...summarize(group),
      truncated: group.filter((item) => item.truncated).length,
      averageAttempts: group.length
        ? group.reduce((sum, item) => sum + item.attempts, 0) / group.length
        : 0,
    })).sort((left, right) => right.count - left.count),
  };
}

function summarize(values) {
  const durations = values.map((item) => item.durationMs).filter((value) => Number.isFinite(value) && value >= 0);
  if (!durations.length) return emptySummary();
  const sorted = [...durations].sort((left, right) => left - right);
  const recent = durations.slice(0, 3);
  const older = durations.slice(3, 6);
  return {
    count: durations.length,
    averageMs: average(durations),
    medianMs: percentile(sorted, 0.5),
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    successRate: values.length ? values.filter((item) => item.ok).length / values.length : 0,
    trend: trendLabel(recent, older),
  };
}

function emptySummary() {
  return { count: 0, averageMs: 0, medianMs: 0, minMs: 0, maxMs: 0, successRate: 0, trend: 'not enough history' };
}

function trendLabel(recent, older) {
  if (!recent.length || !older.length) return 'not enough history';
  const ratio = average(recent) / Math.max(1, average(older));
  if (ratio >= 1.2) return `${Math.round((ratio - 1) * 100)}% slower recently`;
  if (ratio <= 0.8) return `${Math.round((1 - ratio) * 100)}% faster recently`;
  return 'stable recently';
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index] ?? 0;
}
