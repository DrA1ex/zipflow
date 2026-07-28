import {
  createProblem,
  ERROR_CODES,
} from '../protocol/index.js';

const STABLE_CODES = new Set(ERROR_CODES);
const INTERNAL_SERVER_ERROR_TITLE = 'Internal server error';

const INTERNAL_CODE_MAP = Object.freeze({
  AUTHENTICATION_REQUIRED: 'AUTH_REQUIRED',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_REQUIRED',
  INVALID_IDEMPOTENCY_KEY: 'IDEMPOTENCY_REQUIRED',
  IDEMPOTENCY_CLAIM_MISSING: 'IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_ALREADY_SETTLED: 'IDEMPOTENCY_CONFLICT',
  PROJECT_OPERATION_BUSY: 'OPERATION_BUSY',
  SERVER_RUNTIME_BUSY: 'OPERATION_BUSY',
  SERVER_STOPPING: 'OPERATION_BUSY',
  BLOB_TOO_LARGE: 'ARCHIVE_LIMIT_EXCEEDED',
  INVALID_BLOB_ID: 'ACTION_INPUT_INVALID',
  INVALID_CONTENT_LENGTH: 'ACTION_INPUT_INVALID',
  CONTENT_LENGTH_MISMATCH: 'ACTION_INPUT_INVALID',
  INVALID_JSON: 'ACTION_INPUT_INVALID',
  INVALID_PATH_PARAMETER: 'ACTION_INPUT_INVALID',
  INVALID_REQUEST_TARGET: 'ACTION_INPUT_INVALID',
  INVALID_EVENT_CURSOR: 'ACTION_INPUT_INVALID',
  UNSUPPORTED_MEDIA_TYPE: 'ACTION_INPUT_INVALID',
  PAYLOAD_TOO_LARGE: 'ARCHIVE_LIMIT_EXCEEDED',
  PROJECT_PATH_INVALID: 'PROJECT_NOT_FOUND',
});

export function createServerProblem({
  status = 500,
  code = 'INTERNAL_ERROR',
  detail = '',
  details = null,
} = {}) {
  try {
    const stableCode = normalizeProblemCode(code, status);
    const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : undefined;
    return createProblem(stableCode, {
      status: safeStatus,
      message: safeProblemMessage(detail, safeStatus ?? 500),
      details: safeProblemDetails(details, safeStatus ?? 500),
    });
  } catch {
    return {
      type: 'https://zipflow.dev/problems/internal-error',
      title: INTERNAL_SERVER_ERROR_TITLE,
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The local Zipflow server could not complete the request.',
      retryable: true,
      details: {},
      recoveryAction: 'retry',
    };
  }
}

export function normalizeProblemCode(code, status) {
  if (STABLE_CODES.has(code)) return code;
  if (INTERNAL_CODE_MAP[code]) return INTERNAL_CODE_MAP[code];
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 413) return 'ARCHIVE_LIMIT_EXCEEDED';
  if (status === 404 && String(code).includes('OPERATION')) return 'OPERATION_NOT_FOUND';
  if (status === 404 && String(code).includes('PROJECT')) return 'PROJECT_NOT_FOUND';
  if (status >= 400 && status < 500) return 'ACTION_INPUT_INVALID';
  return 'INTERNAL_ERROR';
}

function safeProblemMessage(value, status) {
  if (status >= 500) return 'The local Zipflow server could not complete the request.';
  const message = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!message || /(authorization|bearer|token|secret|password|credential)/i.test(message)) {
    return 'The request could not be completed.';
  }
  return message.slice(0, 512);
}

function safeProblemDetails(value, status) {
  if (status >= 500 || !value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) continue;
    if (/(authorization|bearer|token|secret|password|credential|path)/i.test(key)) continue;
    if (typeof item === 'boolean' || item === null) output[key] = item;
    else if (Number.isSafeInteger(item)) output[key] = item;
    else if (typeof item === 'string') output[key] = item.slice(0, 256);
    else if (Array.isArray(item)) {
      output[key] = item.slice(0, 20)
        .filter((entry) => ['string', 'number', 'boolean'].includes(typeof entry))
        .map((entry) => typeof entry === 'string' ? entry.slice(0, 256) : entry);
    }
  }
  return output;
}
