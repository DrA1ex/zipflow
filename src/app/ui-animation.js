export function uiAnimationActive(state) {
  const panel = state.settingsPanel;
  return Boolean(
    state.busy
    || state.llmRuntime
    || panel?.loadingModels
    || panel?.loadingStorage
    || panel?.modelTest?.running
    || panel?.modelConfig?.loading
    || panel?.modelTestWorkspace?.running
  );
}

export function advanceUiAnimation(state) {
  if (!uiAnimationActive(state)) return false;
  state.uiAnimationFrame = ((Number(state.uiAnimationFrame) || 0) + 1) % 10_000;
  return true;
}
