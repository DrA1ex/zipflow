export const API_VERSION = '1.0';
export const API_MAJOR_VERSION = 1;
export const API_PREFIX = '/v1';
export const SCHEMA_REVISION = 1;
export const MIN_SCHEMA_REVISION = 1;
export const MAX_SCHEMA_REVISION = 1;

export const CAPABILITIES = freeze([
  'projects',
  'workflow_config',
  'blobs',
  'archive_runs',
  'check_runs',
  'deploy_runs',
  'project_setup_actions',
  'semantic_surfaces',
  'actions',
  'plans',
  'diffs',
  'history',
  'rollback',
  'events',
]);

export const ERROR_CODES = freeze([
  'AUTH_REQUIRED',
  'API_INCOMPATIBLE',
  'CAPABILITY_MISSING',
  'PROJECT_NOT_FOUND',
  'RUN_NOT_FOUND',
  'OPERATION_NOT_FOUND',
  'STALE_REVISION',
  'ACTION_NOT_AVAILABLE',
  'ACTION_INPUT_INVALID',
  'IDEMPOTENCY_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'OPERATION_BUSY',
  'UNSAFE_ARCHIVE',
  'ARCHIVE_LIMIT_EXCEEDED',
  'CANCEL_DEFERRED',
  'STREAM_GAP',
  'INTERNAL_ERROR',
]);

export const RUN_STATUSES = freeze([
  'created',
  'inspecting',
  'waiting_action',
  'applying',
  'checking',
  'committing',
  'deploying',
  'completed',
  'failed',
  'cancelled',
  'rolled_back',
  'uncertain',
]);

export const OPERATION_SETTLEMENTS = freeze([
  'active',
  'cancel_requested',
  'cancel_deferred',
  'succeeded',
  'failed',
  'cancelled',
  'uncertain',
]);

export const SURFACE_KINDS = freeze([
  'project_home',
  'workflow_setup',
  'archive_inspecting',
  'archive_root_choice',
  'archive_safety',
  'plan_review',
  'plan_files',
  'conflict_summary',
  'conflict_file',
  'operation_progress',
  'checks_failed',
  'commit_choice',
  'commit_message',
  'deploy_choice',
  'completed',
  'history',
  'run_details',
  'rollback_confirm',
  'error',
]);

export const SECTION_KINDS = freeze([
  'text',
  'summary_fields',
  'progress',
  'choice_list',
  'plan_summary',
  'file_groups',
  'file_details',
  'conflict',
  'check_results',
  'commit',
  'deployment',
  'history_rows',
  'warning_list',
  'error',
]);

export const ACTION_RISKS = freeze(['read', 'project_write', 'process', 'git', 'deploy']);
export const ACTION_CONFIRMATIONS = freeze(['none', 'explicit', 'dangerous']);
export const ACTION_PRESENTATION_ROLES = freeze(['primary', 'secondary', 'destructive']);

export const EVENT_TYPES = freeze([
  'project.changed',
  'workflow.changed',
  'surface.changed',
  'operation.started',
  'operation.progress',
  'operation.cancel_requested',
  'operation.settled',
  'run.attention',
  'run.completed',
  'run.failed',
  'run.rolled_back',
  'stream.gap',
  'server.stopping',
]);

export const PROTOCOL_MEDIA_TYPES = Object.freeze({
  json: 'application/json',
  problem: 'application/problem+json',
  zip: 'application/zip',
  events: 'text/event-stream',
});

export const PROTOCOL_PATHS = Object.freeze({
  hello: `${API_PREFIX}/hello`,
  openapi: `${API_PREFIX}/openapi.json`,
  schemas: `${API_PREFIX}/schemas`,
  events: `${API_PREFIX}/events`,
});

// Explicit aliases make the package boundary unambiguous to consumers that also
// use Zipflow's workflow-file and browser protocol versions.
export const ZIPFLOW_API_VERSION = API_VERSION;
export const ZIPFLOW_SCHEMA_REVISION = SCHEMA_REVISION;
export const REQUIRED_CAPABILITIES = CAPABILITIES;

function freeze(values) {
  return Object.freeze(values);
}
