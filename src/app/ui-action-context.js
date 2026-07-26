export function captureScreenActionContext(state) {
  return {
    sourceScreen: String(state?.screen ?? ''),
    sourceGeneration: Number(state?.screenGeneration) || 0,
  };
}

export function bindScreenAction(context, action) {
  return { ...action, ...context };
}

export function isScreenActionCurrent(state, action) {
  if (!action || action.sourceScreen === undefined || action.sourceGeneration === undefined) return true;
  return String(state?.screen ?? '') === String(action.sourceScreen)
    && (Number(state?.screenGeneration) || 0) === (Number(action.sourceGeneration) || 0);
}
