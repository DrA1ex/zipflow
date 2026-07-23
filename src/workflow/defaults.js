import { defaultAutonomy, normalizeAutonomy } from '../autonomy/policies.js';

export const WORKFLOW_VERSION = 8;

export const DEFAULT_EXCLUDES = [
  '.git/**',
  '.zipflow/**',
  '.commit_message',
  '.commit_message.txt',
  'commit_message.txt',
  'COMMIT_MESSAGE',
  'COMMIT_MESSAGE.txt',
  'node_modules/**',
  '.venv/**',
  'venv/**',
  '.env',
  '.env.*',
  '.DS_Store',
  '__pycache__/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '__MACOSX/**',
];

export const POLICY_PROFILES = {
  safe: {
    id: 'safe',
    label: 'Safe',
    confirmPlan: true,
    conflictPolicy: 'ask',
    failedChecks: 'ask',
  },
  practical: {
    id: 'practical',
    label: 'Practical',
    confirmPlan: false,
    conflictPolicy: 'ask',
    failedChecks: 'ask',
  },
  trust: {
    id: 'trust',
    label: 'Trust archive',
    confirmPlan: false,
    conflictPolicy: 'overwrite',
    failedChecks: 'keep',
  },
};

export function createRecommendedWorkflow(project) {
  const now = new Date().toISOString();
  return {
    version: WORKFLOW_VERSION,
    name: project.name,
    projectPath: project.root,
    projectTypes: (project.workspaceTechnologies ?? project.technologies ?? []).map((item) => item.id),
    projectLabels: project.workspaceLabels ?? project.labels ?? [],
    projects: workflowProjects(project),
    archive: {
      mode: 'overlay',
      stripSingleRootDirectory: true,
      allowGitIgnoredIncomingFiles: 'no',
    },
    deletion: { scope: 'tracked-only' },
    exclude: [...DEFAULT_EXCLUDES],
    checks: project.checks.map((check) => ({ ...check })),
    policy: { ...POLICY_PROFILES.practical },
    autonomy: defaultAutonomy(),
    git: {
      checkpoint: 'ask',
      resultCommit: 'ask',
      messageStrategy: 'metadata',
      fixedMessage: 'zipflow: apply {runId}',
    },
    deploy: {
      policy: 'disabled',
      commandText: '',
      cwd: '.',
      timeoutMs: 900_000,
    },
    lastRunId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyPolicyProfile(workflow, profileId) {
  workflow.policy = { ...(POLICY_PROFILES[profileId] ?? POLICY_PROFILES.practical) };
  return workflow;
}

export function normalizeWorkflow(workflow) {
  const normalized = structuredClone(workflow);
  normalized.version = WORKFLOW_VERSION;
  const configuredExcludes = normalized.exclude ?? [];
  normalized.exclude = Array.from(new Set([...DEFAULT_EXCLUDES, ...configuredExcludes]));
  normalized.archive = {
    mode: 'overlay',
    stripSingleRootDirectory: true,
    allowGitIgnoredIncomingFiles: 'no',
    ...(normalized.archive ?? {}),
  };
  normalized.archive.allowGitIgnoredIncomingFiles = 'no';
  normalized.deletion = { scope: 'tracked-only', ...(normalized.deletion ?? {}) };
  normalized.policy = { ...POLICY_PROFILES.practical, ...(normalized.policy ?? {}) };
  normalized.autonomy = normalizeAutonomy(normalized.autonomy);
  normalized.git = {
    checkpoint: 'ask',
    resultCommit: 'ask',
    messageStrategy: 'metadata',
    fixedMessage: 'zipflow: apply {runId}',
    ...(normalized.git ?? {}),
  };
  normalized.deploy = {
    policy: 'disabled',
    commandText: '',
    cwd: '.',
    timeoutMs: 900_000,
    ...(normalized.deploy ?? {}),
  };
  normalized.deploy.cwd = normalized.deploy.cwd || '.';
  normalized.checks = Array.isArray(normalized.checks)
    ? normalized.checks.map((check) => ({ ...check, cwd: check.cwd || '.', projectPath: check.projectPath || check.cwd || '.' }))
    : [];
  normalized.projects = normalizeProjects(normalized);
  return normalized;
}

function workflowProjects(project) {
  const entries = Array.isArray(project.projects) && project.projects.length
    ? project.projects.filter((entry) => entry.selected !== false)
    : [{ path: '.', technologies: project.technologies ?? [], labels: project.labels ?? [], source: 'detected' }];
  return entries.map((entry) => ({
    path: entry.path || '.',
    typeIds: (entry.technologies ?? []).map((item) => item.id),
    labels: [...(entry.labels ?? [])],
    source: entry.source ?? 'detected',
    selected: true,
  }));
}

function normalizeProjects(workflow) {
  if (Array.isArray(workflow.projects) && workflow.projects.length) {
    return workflow.projects.map((entry) => ({
      path: entry.path || '.',
      typeIds: Array.isArray(entry.typeIds) ? entry.typeIds : [],
      labels: Array.isArray(entry.labels) ? entry.labels : [],
      source: entry.source ?? 'detected',
      selected: entry.selected !== false,
    }));
  }
  return [{
    path: '.',
    typeIds: Array.isArray(workflow.projectTypes) ? workflow.projectTypes : [],
    labels: Array.isArray(workflow.projectLabels) ? workflow.projectLabels : [],
    source: 'legacy',
    selected: true,
  }];
}
