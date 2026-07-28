import {
  ACTION_CONFIRMATIONS,
  ACTION_PRESENTATION_ROLES,
  ACTION_RISKS,
} from '../protocol/constants.js';

function freezeSchema(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  for (const child of Object.values(value)) {
    freezeSchema(child);
  }
  return Object.freeze(value);
}

const INPUT_SCHEMAS = Object.freeze({
  workflow: freezeSchema({
    type: 'object',
    required: ['workflow'],
    additionalProperties: false,
    properties: {
      workflow: {
        type: 'object',
        additionalProperties: true,
      },
    },
  }),
  archiveRoot: freezeSchema({
    type: 'object',
    required: ['rootId'],
    additionalProperties: false,
    properties: {
      rootId: { type: 'string', minLength: 1, maxLength: 512 },
    },
  }),
  path: freezeSchema({
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 4096 },
    },
  }),
  conflict: freezeSchema({
    type: 'object',
    required: ['path', 'decision'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 4096 },
      decision: { type: 'string', enum: ['archive', 'keep'] },
    },
  }),
  commit: freezeSchema({
    type: 'object',
    required: ['message'],
    additionalProperties: false,
    properties: {
      message: { type: 'string', minLength: 1, maxLength: 4096 },
    },
  }),
});

function defineAction({
  id,
  kind,
  label,
  description,
  risk,
  confirmation,
  role = 'secondary',
  inputSchema = null,
}) {
  if (!ACTION_RISKS.includes(risk)) {
    throw new TypeError(`Unknown action risk: ${risk}`);
  }
  if (!ACTION_CONFIRMATIONS.includes(confirmation)) {
    throw new TypeError(`Unknown action confirmation: ${confirmation}`);
  }
  if (!ACTION_PRESENTATION_ROLES.includes(role)) {
    throw new TypeError(`Unknown action presentation role: ${role}`);
  }

  return Object.freeze({
    id,
    kind,
    'label': label,
    'description': description,
    risk,
    confirmation,
    inputSchema,
    presentation: Object.freeze({ role }),
  });
}

const definitions = [
  defineAction({ id: 'save-workflow', kind: 'save_workflow', 'label': 'Save workflow', 'description': 'Save workflow settings for this project.', risk: 'project_write', confirmation: 'explicit', role: 'primary', inputSchema: INPUT_SCHEMAS.workflow }),
  defineAction({ id: 'select-archive-root', kind: 'select_archive_root', 'label': 'Select archive root', 'description': 'Choose which archive directory represents the project root.', risk: 'read', confirmation: 'explicit', role: 'primary', inputSchema: INPUT_SCHEMAS.archiveRoot }),
  defineAction({ id: 'acknowledge-archive-safety', kind: 'acknowledge_archive_safety', 'label': 'Continue', 'description': 'Acknowledge archive safety findings and continue.', risk: 'project_write', confirmation: 'explicit', role: 'primary' }),
  defineAction({ id: 'approve-plan', kind: 'approve_plan', 'label': 'Apply plan', 'description': 'Approve the resolved plan and update the project.', risk: 'project_write', confirmation: 'explicit', role: 'primary' }),
  defineAction({ id: 'use-archive', kind: 'use_archive', 'label': 'Use archive version', 'description': 'Choose the archive version for a file.', risk: 'project_write', confirmation: 'explicit', inputSchema: INPUT_SCHEMAS.path }),
  defineAction({ id: 'keep-local', kind: 'keep_local', 'label': 'Keep local version', 'description': 'Preserve the current local version of a file.', risk: 'project_write', confirmation: 'explicit', inputSchema: INPUT_SCHEMAS.path }),
  defineAction({ id: 'resolve-conflict', kind: 'resolve_conflict', 'label': 'Resolve conflict', 'description': 'Record a semantic resolution for one conflict.', risk: 'project_write', confirmation: 'explicit', role: 'primary', inputSchema: INPUT_SCHEMAS.conflict }),
  defineAction({ id: 'retry-run', kind: 'retry_run', 'label': 'Retry', 'description': 'Retry the failed run step.', risk: 'process', confirmation: 'explicit', role: 'primary' }),
  defineAction({ id: 'cancel-operation', kind: 'cancel_operation', 'label': 'Cancel operation', 'description': 'Request cancellation of the active operation.', risk: 'process', confirmation: 'explicit', role: 'destructive' }),
  defineAction({ id: 'retry-checks', kind: 'retry_checks', 'label': 'Run checks again', 'description': 'Execute the configured validation checks again.', risk: 'process', confirmation: 'explicit', role: 'primary' }),
  defineAction({ id: 'prepare-commit', kind: 'prepare_commit', 'label': 'Continue to commit', 'description': 'Continue to the commit message step.', risk: 'git', confirmation: 'explicit', role: 'primary' }),
  defineAction({ id: 'commit', kind: 'commit', 'label': 'Commit changes', 'description': 'Create a Git commit for the completed project changes.', risk: 'git', confirmation: 'explicit', role: 'primary', inputSchema: INPUT_SCHEMAS.commit }),
  defineAction({ id: 'continue-without-commit', kind: 'continue_without_commit', 'label': 'Continue without commit', 'description': 'Leave the project changes uncommitted.', risk: 'git', confirmation: 'explicit' }),
  defineAction({ id: 'deploy', kind: 'deploy', 'label': 'Deploy', 'description': 'Run the configured deployment workflow.', risk: 'deploy', confirmation: 'dangerous', role: 'primary' }),
  defineAction({ id: 'skip-deploy', kind: 'skip_deploy', 'label': 'Skip deployment', 'description': 'Finish the run without deploying.', risk: 'deploy', confirmation: 'explicit' }),
  defineAction({ id: 'finish', kind: 'finish', 'label': 'Finish', 'description': 'Return to the project overview.', risk: 'read', confirmation: 'none', role: 'primary' }),
  defineAction({ id: 'rollback', kind: 'rollback', 'label': 'Roll back', 'description': 'Restore the project from the selected run backup.', risk: 'project_write', confirmation: 'dangerous', role: 'destructive' }),
  defineAction({ id: 'dismiss-error', kind: 'dismiss_error', 'label': 'Close', 'description': 'Dismiss the error and return to the project.', risk: 'read', confirmation: 'none' }),
];

export const SEMANTIC_ACTION_DEFINITIONS = Object.freeze(definitions);
export const SEMANTIC_ACTION_IDS = Object.freeze(definitions.map(({ id }) => id));
export const SEMANTIC_ACTION_KINDS = Object.freeze(definitions.map(({ kind }) => kind));

const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));

export function getSemanticActionDefinition(actionId) {
  return definitionById.get(actionId) ?? null;
}
