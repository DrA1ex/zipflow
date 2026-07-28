import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { createProblem, problemError } from '../protocol/errors.js';
import { PROTOCOL_MEDIA_TYPES } from '../protocol/constants.js';
import { normalizeLocalEndpoint } from './local-endpoint.js';

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export class ZipflowTransportError extends Error {
  constructor(code, message, { cause = undefined, statusCode = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ZipflowTransportError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class LocalEndpointHttpClient {
  constructor({
    endpoint = undefined,
    socketPath = undefined,
    token,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    requestImpl = http.request,
  } = {}) {
    this.endpoint = normalizeLocalEndpoint(endpoint ?? socketPath);
    this.token = validateToken(token);
    this.timeoutMs = positiveInteger(timeoutMs, 'timeoutMs');
    this.maxResponseBytes = positiveInteger(maxResponseBytes, 'maxResponseBytes');
    if (typeof requestImpl !== 'function') throw new TypeError('requestImpl must be a function.');
    this.requestImpl = requestImpl;
  }

  async request(path, options = {}) {
    const response = await this.openResponse(path, options);
    const buffer = await readResponseBuffer(response, this.maxResponseBytes);
    const body = decodeResponseBody(buffer, response.headers, response.statusCode);
    if (!isSuccess(response.statusCode)) throw responseError(response, body);
    return { statusCode: response.statusCode, headers: response.headers, body };
  }

  async requestJson(path, options = {}) {
    const response = await this.request(path, {
      ...options,
      headers: { accept: PROTOCOL_MEDIA_TYPES.json, ...(options.headers ?? {}) },
    });
    if (response.body === null || typeof response.body !== 'object' || Buffer.isBuffer(response.body)) {
      throw new ZipflowTransportError('INVALID_JSON_RESPONSE', 'Zipflow returned a non-JSON response.', {
        statusCode: response.statusCode,
      });
    }
    return response.body;
  }

  async openStream(path, options = {}) {
    const response = await this.openResponse(path, options);
    if (isSuccess(response.statusCode)) return response;
    const buffer = await readResponseBuffer(response, this.maxResponseBytes);
    const body = decodeResponseBody(buffer, response.headers, response.statusCode);
    throw responseError(response, body);
  }

  openResponse(path, {
    method = 'GET',
    headers = {},
    body = undefined,
    signal = undefined,
    timeoutMs = this.timeoutMs,
  } = {}) {
    const requestPath = validateRequestPath(path);
    const encoded = encodeRequestBody(body, headers);
    const requestHeaders = authenticatedHeaders(headers, this.token, encoded);
    const requestTimeoutMs = positiveInteger(timeoutMs, 'timeoutMs');

    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      let settled = false;
      let timer = null;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else {
          attachResponseAbort(response, signal);
          resolve(response);
        }
      };
      const request = this.requestImpl({
        socketPath: this.endpoint.socketPath,
        path: requestPath,
        method: String(method).toUpperCase(),
        headers: requestHeaders,
      }, (response) => finish(null, response));
      const onAbort = () => request.destroy(abortError());
      request.once('error', (error) => finish(normalizeRequestError(error)));
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => request.destroy(new ZipflowTransportError(
        'REQUEST_TIMEOUT', `Zipflow did not respond within ${requestTimeoutMs} ms.`,
      )), requestTimeoutMs);
      timer.unref?.();
      if (encoded.stream) {
        void pipeline(encoded.stream, request, signal ? { signal } : {}).catch((error) => {
          request.destroy(normalizeRequestError(error));
        });
      } else {
        if (encoded.buffer) request.write(encoded.buffer);
        request.end();
      }
      return undefined;
    });
  }
}

export function createLocalEndpointHttpClient(options) {
  return new LocalEndpointHttpClient(options);
}

export async function readResponseBuffer(response, maximumBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maximumBytes) {
        response.destroy();
        throw new ZipflowTransportError('RESPONSE_TOO_LARGE', `Zipflow response exceeds ${maximumBytes} bytes.`, {
          statusCode: response.statusCode,
        });
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ZipflowTransportError) throw error;
    throw normalizeRequestError(error);
  }
  return Buffer.concat(chunks, total);
}

function encodeRequestBody(body, headers) {
  if (body === undefined || body === null) return { buffer: null, stream: null, contentType: null };
  if (Buffer.isBuffer(body)) return { buffer: body, stream: null, contentType: null };
  if (body instanceof Uint8Array) return { buffer: Buffer.from(body), stream: null, contentType: null };
  if (typeof body === 'string') return { buffer: Buffer.from(body), stream: null, contentType: null };
  if (isStreamBody(body)) return { buffer: null, stream: body, contentType: null };
  if (typeof body === 'object') {
    return { buffer: Buffer.from(JSON.stringify(body)), stream: null, contentType: PROTOCOL_MEDIA_TYPES.json };
  }
  throw new TypeError('HTTP request body must be JSON, text, Buffer, or Uint8Array.');
}

function authenticatedHeaders(input, token, encoded) {
  const headers = { ...input };
  const authorizationName = findHeader(headers, 'authorization');
  if (authorizationName && headers[authorizationName] !== `Bearer ${token}`) {
    throw new TypeError('Authorization is owned by the Zipflow client token.');
  }
  headers[authorizationName ?? 'authorization'] = `Bearer ${token}`;
  if (!findHeader(headers, 'accept')) headers.accept = PROTOCOL_MEDIA_TYPES.json;
  if (!findHeader(headers, 'user-agent')) headers['user-agent'] = 'zipflow-client/1';
  if (encoded.buffer) {
    const lengthName = findHeader(headers, 'content-length');
    if (lengthName && Number(headers[lengthName]) !== encoded.buffer.length) {
      throw new TypeError('Content-Length does not match the encoded request body.');
    }
    headers[lengthName ?? 'content-length'] = String(encoded.buffer.length);
    if (encoded.contentType && !findHeader(headers, 'content-type')) headers['content-type'] = encoded.contentType;
  } else if (encoded.stream) {
    const lengthName = findHeader(headers, 'content-length');
    const contentLength = lengthName ? Number(headers[lengthName]) : NaN;
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new TypeError('Streaming request bodies require an explicit non-negative Content-Length.');
    }
  }
  return headers;
}

function decodeResponseBody(buffer, headers, statusCode) {
  if (buffer.length === 0 || statusCode === 204) return null;
  const mediaType = String(headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType === PROTOCOL_MEDIA_TYPES.json || mediaType === PROTOCOL_MEDIA_TYPES.problem || mediaType.endsWith('+json')) {
    try { return JSON.parse(buffer.toString('utf8')); } catch (cause) {
      throw new ZipflowTransportError('INVALID_JSON_RESPONSE', 'Zipflow returned malformed JSON.', { cause, statusCode });
    }
  }
  return buffer;
}

function responseError(response, body) {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    return problemError(body, { headers: response.headers });
  }
  return problemError(createProblem('INTERNAL_ERROR', {
    status: response.statusCode,
    message: `Zipflow request failed with HTTP ${response.statusCode}.`,
  }), { headers: response.headers });
}

function attachResponseAbort(response, signal) {
  if (!signal) return;
  const abort = () => response.destroy(abortError());
  const detach = () => signal.removeEventListener('abort', abort);
  signal.addEventListener('abort', abort, { once: true });
  response.once('end', detach);
  response.once('close', detach);
  if (signal.aborted) abort();
}

function validateToken(value) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) {
    throw new TypeError('A non-empty Zipflow bearer token is required.');
  }
  return value;
}

function validateRequestPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/v1/') || value.includes('://') || /[\0\r\n]/.test(value)) {
    throw new TypeError('Zipflow request paths must be absolute /v1/ resource paths.');
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function findHeader(headers, expected) {
  return Object.keys(headers).find((name) => name.toLowerCase() === expected);
}

function isStreamBody(value) {
  return value !== null && typeof value === 'object'
    && (typeof value.pipe === 'function' || typeof value[Symbol.asyncIterator] === 'function');
}

function isSuccess(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300;
}

function abortError() {
  const error = new Error('Zipflow request was aborted.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function normalizeRequestError(error) {
  if (error?.name === 'AbortError' || error instanceof ZipflowTransportError) return error;
  return new ZipflowTransportError('CONNECTION_FAILED', 'Could not connect to the local Zipflow endpoint.', { cause: error });
}
