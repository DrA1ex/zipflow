export function startRuntimeClock(controller, runtime, { intervalMs = 250 } = {}) {
  const startedAt = Date.now();
  runtime.startedAt = startedAt;
  runtime.elapsedMs = 0;
  const timer = setInterval(() => {
    runtime.elapsedMs = Date.now() - startedAt;
    controller.invalidate();
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    runtime.elapsedMs = Date.now() - startedAt;
  };
}

export function estimatedProgress(runtime, { cap = 0.96 } = {}) {
  const expectedMs = Number(runtime?.expectedMs) || 0;
  const elapsedMs = Math.max(0, Number(runtime?.elapsedMs) || 0);
  if (expectedMs <= 0) return { determinate: false, elapsedMs, expectedMs: 0, value: 0, total: 1 };
  return {
    determinate: true,
    elapsedMs,
    expectedMs,
    value: Math.min(elapsedMs, Math.max(1, expectedMs * cap)),
    total: expectedMs,
  };
}
