export function initializeArchiveInterpretation(state) {
  const configuredMode = normalizeMode(state.workflow?.archive?.mode);
  state.archiveInterpretation = {
    configuredMode,
    mode: configuredMode,
    source: 'workflow',
    changedAt: null,
  };
  return state.archiveInterpretation;
}

export function activeArchiveMode(state) {
  return normalizeMode(state.archiveInterpretation?.mode ?? state.workflow?.archive?.mode);
}

export function activeArchiveWorkflow(state, mode = activeArchiveMode(state)) {
  const workflow = structuredClone(state.workflow);
  workflow.archive = { ...(workflow.archive ?? {}), mode: normalizeMode(mode) };
  return workflow;
}

export function setArchiveInterpretation(state, mode, source = 'manual') {
  const configuredMode = normalizeMode(state.archiveInterpretation?.configuredMode ?? state.workflow?.archive?.mode);
  state.archiveInterpretation = {
    configuredMode,
    mode: normalizeMode(mode),
    source,
    changedAt: new Date().toISOString(),
  };
  return state.archiveInterpretation;
}

export function clearArchiveInterpretation(state) {
  state.archiveInterpretation = null;
}

export function archiveInterpretationLabel(state) {
  return activeArchiveMode(state) === 'snapshot' ? 'Full snapshot' : 'Patch / overlay';
}

function normalizeMode(value) {
  return value === 'snapshot' ? 'snapshot' : 'overlay';
}
