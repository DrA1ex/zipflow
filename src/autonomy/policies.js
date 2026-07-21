export const AUTONOMY_MODES = Object.freeze({
  manual: {
    id: 'manual',
    label: 'Manual',
    dangerous: false,
    description: 'Zipflow follows workflow rules and asks you at every unresolved decision.',
    capabilities: {},
  },
  guarded: {
    id: 'guarded',
    label: 'Guarded autopilot',
    dangerous: false,
    description: 'The local LLM may resolve routine and reversible decisions. Zipflow pauses for meaningful risk or low confidence.',
    capabilities: {
      decidePlanApplication: true,
      decideConflicts: false,
      decideFailedChecks: true,
      decideResultCommit: true,
      decideCommitRewrite: false,
      decideDeployment: true,
      allowCommitAfterFailedChecks: false,
      allowDeployAfterFailedChecks: false,
      allowRewriteUnpublishedCommits: false,
    },
  },
  full: {
    id: 'full',
    label: 'Full autopilot · Dangerous',
    dangerous: true,
    description: 'The local LLM may accept risky updates, keep failed results, rewrite eligible local commits, and run configured deployment.',
    capabilities: {
      decidePlanApplication: true,
      decideConflicts: true,
      decideFailedChecks: true,
      decideResultCommit: true,
      decideCommitRewrite: true,
      decideDeployment: true,
      allowCommitAfterFailedChecks: true,
      allowDeployAfterFailedChecks: true,
      allowRewriteUnpublishedCommits: true,
    },
  },
});

export function defaultAutonomy() {
  return autonomyForMode('manual');
}

export function autonomyForMode(mode) {
  const profile = AUTONOMY_MODES[mode] ?? AUTONOMY_MODES.manual;
  return {
    mode: profile.id,
    profileVersion: 1,
    maxDecisionRetries: 1,
    maxCheckRetries: 1,
    maxDeployRetries: 1,
    capabilities: { ...profile.capabilities },
  };
}

export function normalizeAutonomy(value) {
  const mode = AUTONOMY_MODES[value?.mode] ? value.mode : 'manual';
  const base = autonomyForMode(mode);
  return {
    ...base,
    ...(value ?? {}),
    mode,
    capabilities: { ...base.capabilities, ...(value?.capabilities ?? {}) },
  };
}

export function autonomyProfile(value) {
  return AUTONOMY_MODES[value?.mode] ?? AUTONOMY_MODES.manual;
}

export function isAutopilotEnabled(workflow) {
  return ['guarded', 'full'].includes(workflow?.autonomy?.mode);
}

export function canAutonomy(workflow, capability) {
  return Boolean(isAutopilotEnabled(workflow) && workflow.autonomy.capabilities?.[capability]);
}

export function confidenceThreshold(mode) {
  return mode === 'full' ? 0.55 : 0.8;
}
