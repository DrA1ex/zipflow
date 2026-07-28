import { ERROR_CODES } from './constants.js';

const DEFINITIONS = {
  AUTH_REQUIRED: [401, 'Authentication required', false, null],
  API_INCOMPATIBLE: [409, 'Incompatible API version', false, 'reconnect'],
  CAPABILITY_MISSING: [409, 'Required capability is missing', false, 'reconnect'],
  PROJECT_NOT_FOUND: [404, 'Project not found', false, 'refresh'],
  RUN_NOT_FOUND: [404, 'Run not found', false, 'refresh'],
  OPERATION_NOT_FOUND: [404, 'Operation not found', false, 'refresh'],
  STALE_REVISION: [409, 'Stale workflow revision', true, 'refresh'],
  ACTION_NOT_AVAILABLE: [409, 'Action is not available', true, 'refresh'],
  ACTION_INPUT_INVALID: [400, 'Action input is invalid', false, null],
  IDEMPOTENCY_REQUIRED: [400, 'Idempotency key is required', false, null],
  IDEMPOTENCY_CONFLICT: [409, 'Idempotency key conflicts with an earlier request', false, 'refresh'],
  OPERATION_BUSY: [409, 'Project operation is busy', true, 'refresh'],
  UNSAFE_ARCHIVE: [422, 'Archive is unsafe', false, null],
  ARCHIVE_LIMIT_EXCEEDED: [413, 'Archive limit exceeded', false, null],
  CANCEL_DEFERRED: [202, 'Cancellation is deferred', true, 'refresh'],
  STREAM_GAP: [409, 'Event stream cursor is no longer retained', true, 'resynchronize'],
  INTERNAL_ERROR: [500, 'Internal server error', true, 'retry'],
};

export const ERROR_DEFINITIONS = deepFreeze(Object.fromEntries(ERROR_CODES.map((code) => {
  const [status, title, retryable, recoveryAction] = DEFINITIONS[code];
  return [code, { status, title, retryable, recoveryAction }];
})));

export class ZipflowApiError extends Error {
  constructor(problem, { cause = undefined, headers = undefined } = {}) {
    const safeProblem = normalizeProblem(problem);
    super(safeProblem.message || safeProblem.title, cause === undefined ? undefined : { cause });
    this.name = 'ZipflowApiError';
    this.code = safeProblem.code;
    this.status = safeProblem.status;
    this.retryable = safeProblem.retryable;
    this.details = safeProblem.details;
    this.recoveryAction = safeProblem.recoveryAction;
    this.problem = safeProblem;
    this.headers = headers;
    this.expose = true;
    this.detail = safeProblem.message;
  }
}

export class ZipflowCompatibilityError extends ZipflowApiError {
  constructor(code, message, details = {}) {
    if (!['API_INCOMPATIBLE', 'CAPABILITY_MISSING'].includes(code)) {
      throw new TypeError(`Unsupported compatibility error code: ${code}`);
    }
    super(createProblem(code, { message, details }));
    this.name = 'ZipflowCompatibilityError';
  }
}

export function createProblem(code, {
  message = undefined,
  status = undefined,
  title = undefined,
  retryable = undefined,
  details = {},
  recoveryAction = undefined,
} = {}) {
  const definition = ERROR_DEFINITIONS[code];
  if (!definition) throw new TypeError(`Unknown Zipflow problem code: ${code}`);
  return {
    type: `https://zipflow.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: title ?? definition.title,
    status: status ?? definition.status,
    code,
    message: message ?? definition.title,
    retryable: retryable ?? definition.retryable,
    details: isObject(details) ? structuredClone(details) : {},
    recoveryAction: recoveryAction === undefined ? definition.recoveryAction : recoveryAction,
  };
}

export function isProblemDocument(value) {
  return isObject(value)
    && typeof value.type === 'string'
    && typeof value.title === 'string'
    && Number.isInteger(value.status)
    && ERROR_CODES.includes(value.code)
    && typeof value.message === 'string'
    && typeof value.retryable === 'boolean'
    && isObject(value.details)
    && (value.recoveryAction === null || typeof value.recoveryAction === 'string');
}

export function problemError(value, options = {}) {
  return new ZipflowApiError(isProblemDocument(value)
    ? value
    : createProblem('INTERNAL_ERROR', { message: 'The server returned an invalid error response.' }), options);
}

function normalizeProblem(value) {
  if (isProblemDocument(value)) return structuredClone(value);
  return createProblem('INTERNAL_ERROR', {
    message: typeof value?.message === 'string' ? value.message : 'Zipflow request failed.',
  });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
