import { authenticateRequest } from './auth.js';

export const DEFAULT_JSON_BODY_LIMIT = 1024 * 1024;

export class LocalHttpRouter {
  constructor({
    token,
    problemFactory = defaultProblem,
    jsonBodyLimit = DEFAULT_JSON_BODY_LIMIT,
    onError = () => {},
  } = {}) {
    if (!token) throw new TypeError('Router token is required.');
    this.token = token;
    this.problemFactory = problemFactory;
    this.jsonBodyLimit = jsonBodyLimit;
    this.onError = onError;
    this.routes = [];
  }

  add(method, template, handler, options = {}) {
    if (typeof handler !== 'function') throw new TypeError('A route handler is required.');
    const route = compileRoute(method, template);
    this.routes.push({ ...route, handler, options });
    return this;
  }

  get(template, handler, options) {
    return this.add('GET', template, handler, options);
  }

  post(template, handler, options) {
    return this.add('POST', template, handler, options);
  }

  put(template, handler, options) {
    return this.add('PUT', template, handler, options);
  }

  async handle(request, response) {
    try {
      const requestUrl = safeRequestUrl(request.url);
      if (requestUrl.pathname.startsWith('/v1')) authenticateRequest(request, this.token);
      const matched = this.match(request.method, requestUrl.pathname);
      if (!matched) throw new ServerHttpError(404, 'NOT_FOUND', 'The requested resource does not exist.');
      const { route, params } = matched;
      const idempotencyKey = route.options.idempotency
        ? requireIdempotencyKey(request.headers['idempotency-key'])
        : readOptionalIdempotencyKey(request.headers['idempotency-key']);
      const body = route.options.body === 'json'
        ? await readJsonBody(request, { limit: route.options.bodyLimit ?? this.jsonBodyLimit })
        : undefined;
      const result = await route.handler({
        request,
        response,
        method: request.method,
        pathname: requestUrl.pathname,
        query: requestUrl.searchParams,
        params,
        body,
        idempotencyKey,
      });
      if (!response.writableEnded && result !== undefined) writeRouteResult(response, result);
    } catch (error) {
      if (response.writableEnded || response.headersSent) {
        response.destroy();
        return;
      }
      const normalized = normalizeHttpError(error);
      if (normalized.status >= 500) this.onError(error);
      let body;
      try {
        body = this.problemFactory({
          status: normalized.status,
          code: normalized.code,
          detail: normalized.detail,
          details: normalized.details,
          errors: normalized.errors,
        });
      } catch {
        body = defaultProblem({
          status: 500,
          code: 'INTERNAL_ERROR',
          detail: 'The local Zipflow server could not complete the request.',
        });
      }
      writeJson(response, normalized.status, body, normalized.headers);
    }
  }

  match(method, pathname) {
    const upperMethod = String(method ?? '').toUpperCase();
    for (const route of this.routes) {
      if (route.method !== upperMethod) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const params = {};
      for (let index = 0; index < route.names.length; index += 1) {
        try {
          params[route.names[index]] = decodeURIComponent(match[index + 1]);
        } catch {
          throw new ServerHttpError(400, 'INVALID_PATH_PARAMETER', 'A path parameter is not valid UTF-8.');
        }
      }
      return { route, params };
    }
    return null;
  }
}

export class ServerHttpError extends Error {
  constructor(status, code, detail, {
    details = null,
    errors = null,
    headers = null,
    cause = null,
  } = {}) {
    super(detail, { cause });
    this.name = 'ServerHttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.details = details;
    this.errors = errors;
    this.headers = headers;
    this.expose = true;
  }
}

export async function readJsonBody(request, { limit = DEFAULT_JSON_BODY_LIMIT } = {}) {
  const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ServerHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
  const declared = parseContentLength(request.headers['content-length']);
  if (declared !== null && declared > limit) {
    throw new ServerHttpError(413, 'PAYLOAD_TOO_LARGE', 'The JSON request body is too large.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new ServerHttpError(413, 'PAYLOAD_TOO_LARGE', 'The JSON request body is too large.');
    }
    chunks.push(chunk);
  }
  if (declared !== null && declared !== size) {
    throw new ServerHttpError(400, 'CONTENT_LENGTH_MISMATCH', 'Content-Length does not match the request body.');
  }
  if (!size) throw new ServerHttpError(400, 'INVALID_JSON', 'A JSON request body is required.');
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new ServerHttpError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
}

export function writeJson(response, status, value, headers = null) {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/problem+json; charset=utf-8',
    'content-length': payload.length,
    ...headers,
  });
  response.end(payload);
}

function writeRouteResult(response, result) {
  const normalized = isRouteEnvelope(result) ? result : { body: result };
  const status = normalized.status ?? 200;
  if (normalized.body === null || status === 204) {
    response.writeHead(status, { 'cache-control': 'no-store', ...normalized.headers });
    response.end();
    return;
  }
  const payload = Buffer.from(`${JSON.stringify(normalized.body)}\n`);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    ...normalized.headers,
  });
  response.end(payload);
}

function isRouteEnvelope(value) {
  return value
    && typeof value === 'object'
    && ('status' in value || 'headers' in value || 'body' in value)
    && Object.keys(value).every((key) => ['status', 'headers', 'body'].includes(key));
}

function compileRoute(method, template) {
  if (!template.startsWith('/')) throw new TypeError('Route templates must be absolute paths.');
  const names = [];
  const segments = template.split('/').map((segment) => {
    if (!segment.startsWith(':')) return escapePattern(segment);
    const name = segment.slice(1);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`Invalid route parameter: ${segment}`);
    names.push(name);
    return '([^/]+)';
  });
  return {
    method: String(method).toUpperCase(),
    template,
    names,
    pattern: new RegExp(`^${segments.join('/')}$`),
  };
}

function normalizeHttpError(error) {
  if (error?.expose && Number.isInteger(error.status)) {
    return {
      status: error.status,
      code: error.code ?? 'REQUEST_FAILED',
      detail: error.detail ?? error.message,
      details: error.details ?? null,
      errors: error.errors ?? null,
      headers: error.headers ?? null,
    };
  }
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    detail: 'The local Zipflow server could not complete the request.',
    details: null,
    errors: null,
    headers: null,
  };
}

function requireIdempotencyKey(value) {
  const key = readOptionalIdempotencyKey(value);
  if (!key) throw new ServerHttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
  return key;
}

function readOptionalIdempotencyKey(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value)) {
    throw new ServerHttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must contain 1 to 256 visible ASCII characters.');
  }
  return value;
}

function parseContentLength(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new ServerHttpError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ServerHttpError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid.');
  }
  return parsed;
}

function safeRequestUrl(value) {
  try {
    return new URL(value ?? '/', 'http://zipflow.local');
  } catch {
    throw new ServerHttpError(400, 'INVALID_REQUEST_TARGET', 'The HTTP request target is invalid.');
  }
}

function defaultProblem({ status, code, detail, errors = null }) {
  return {
    type: 'about:blank',
    status,
    code,
    detail,
    ...(errors ? { errors } : {}),
  };
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
