import {
  API_MAJOR_VERSION,
  CAPABILITIES,
  MAX_SCHEMA_REVISION,
  MIN_SCHEMA_REVISION,
  PROTOCOL_PATHS,
} from '../protocol/constants.js';
import { ZipflowCompatibilityError } from '../protocol/errors.js';
import { assertProtocolValue } from '../protocol/validation.js';
import { LocalEndpointHttpClient } from './http-client.js';
import { ZipflowEventClient } from './event-client.js';

export class ZipflowClient {
  constructor({
    endpoint = undefined,
    socketPath = undefined,
    token,
    requiredCapabilities = CAPABILITIES,
    expectedApiMajor = API_MAJOR_VERSION,
    minimumSchemaRevision = MIN_SCHEMA_REVISION,
    maximumSchemaRevision = MAX_SCHEMA_REVISION,
    httpClient = undefined,
    ...httpOptions
  } = {}) {
    this.http = httpClient ?? new LocalEndpointHttpClient({ endpoint, socketPath, token, ...httpOptions });
    this.requiredCapabilities = uniqueStrings(requiredCapabilities, 'requiredCapabilities');
    this.expectedApiMajor = positiveInteger(expectedApiMajor, 'expectedApiMajor');
    this.minimumSchemaRevision = positiveInteger(minimumSchemaRevision, 'minimumSchemaRevision');
    this.maximumSchemaRevision = positiveInteger(maximumSchemaRevision, 'maximumSchemaRevision');
    if (this.minimumSchemaRevision > this.maximumSchemaRevision) {
      throw new TypeError('minimumSchemaRevision cannot exceed maximumSchemaRevision.');
    }
  }

  async hello({ signal = undefined } = {}) {
    const value = await this.http.requestJson(PROTOCOL_PATHS.hello, { signal });
    this.assertCompatibility(value);
    assertProtocolValue('hello', value);
    return value;
  }

  async getOpenApi({ signal = undefined } = {}) {
    return this.http.requestJson(PROTOCOL_PATHS.openapi, { signal });
  }

  async getSchemas({ signal = undefined } = {}) {
    return this.http.requestJson(PROTOCOL_PATHS.schemas, { signal });
  }

  async openProject(request = {}) {
    const draft = requiredObject(request, 'openProject request');
    const path = requiredText(draft.path, 'path');
    const idempotencyKey = requiredIdempotencyKey(draft.idempotencyKey);
    const client = draft.client === undefined
      ? undefined
      : requiredObject(draft.client, 'client');
    return this.http.requestJson('/v1/projects/open', {
      method: 'POST',
      signal: draft.signal,
      body: {
        path,
        ...(client === undefined ? {} : { client }),
      },
      headers: { 'idempotency-key': idempotencyKey },
    });
  }

  async getProject(projectId, { signal = undefined } = {}) {
    return this.http.requestJson(`/v1/projects/${resourceId(projectId, 'projectId')}`, { signal });
  }

  async getWorkflow(projectId, { signal = undefined } = {}) {
    return this.http.requestJson(`/v1/projects/${resourceId(projectId, 'projectId')}/workflow`, { signal });
  }

  async putWorkflow(projectId, draft, {
    ifMatch,
    idempotencyKey,
    signal = undefined,
  } = {}) {
    return this.#jsonMutation(
      `/v1/projects/${resourceId(projectId, 'projectId')}/workflow`,
      requiredObject(draft, 'workflow draft'),
      { ifMatch, idempotencyKey, signal },
      'PUT',
    );
  }

  async uploadZip(source, {
    filename,
    contentLength,
    idempotencyKey,
    signal = undefined,
  } = {}) {
    const safeFilename = requiredHeaderValue(filename, 'filename');
    const safeKey = requiredIdempotencyKey(idempotencyKey);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new TypeError('contentLength must be a non-negative integer.');
    }
    return this.http.requestJson('/v1/blobs', {
      method: 'POST',
      signal,
      body: source,
      headers: {
        'content-type': 'application/zip',
        'content-length': String(contentLength),
        'x-zipflow-filename': safeFilename,
        'idempotency-key': safeKey,
      },
    });
  }

  async startArchiveRun(projectId, draft, options = {}) {
    return this.#jsonMutation(
      `/v1/projects/${resourceId(projectId, 'projectId')}/runs`,
      requiredObject(draft, 'archive run request'),
      options,
    );
  }

  async startCheckRun(projectId, draft = {}, options = {}) {
    return this.#jsonMutation(
      `/v1/projects/${resourceId(projectId, 'projectId')}/check-runs`,
      requiredObject(draft, 'check run request'),
      options,
    );
  }

  async getRun(runId, { signal = undefined } = {}) {
    return this.http.requestJson(`/v1/runs/${resourceId(runId, 'runId')}`, { signal });
  }

  async getOperation(operationId, { signal = undefined } = {}) {
    return this.http.requestJson(`/v1/operations/${resourceId(operationId, 'operationId')}`, { signal });
  }

  async cancelOperation(operationId, {
    idempotencyKey,
    signal = undefined,
  } = {}) {
    return this.#jsonMutation(
      `/v1/operations/${resourceId(operationId, 'operationId')}/cancel`,
      {},
      { idempotencyKey, signal },
    );
  }

  async getSurface(runId, { signal = undefined } = {}) {
    return this.http.requestJson(`/v1/runs/${resourceId(runId, 'runId')}/surface`, { signal });
  }

  async performAction(runId, actionId, input = {}, options = {}) {
    return this.#jsonMutation(
      `/v1/runs/${resourceId(runId, 'runId')}/actions/${resourceId(actionId, 'actionId')}`,
      { input: requiredObject(input, 'action input') },
      options,
    );
  }

  async getPlan(runId, query = {}) {
    const request = readQuery(query, {
      group: stringQuery,
      cursor: cursorQuery,
      limit: limitQuery,
    });
    return this.http.requestJson(withQuery(
      `/v1/runs/${resourceId(runId, 'runId')}/plan`,
      request.values,
    ), { signal: request.signal });
  }

  async getDiff(runId, query = {}) {
    const request = readQuery(query, {
      path: stringQuery,
      mode: stringQuery,
    });
    return this.http.requestJson(withQuery(
      `/v1/runs/${resourceId(runId, 'runId')}/diff`,
      request.values,
    ), { signal: request.signal });
  }

  async getOutput(runId, query = {}) {
    const request = readQuery(query, {
      source: stringQuery,
      cursor: cursorQuery,
    });
    return this.http.requestJson(withQuery(
      `/v1/runs/${resourceId(runId, 'runId')}/output`,
      request.values,
    ), { signal: request.signal });
  }

  async getReport(runId, { signal = undefined } = {}) {
    return this.http.requestJson(`/v1/runs/${resourceId(runId, 'runId')}/report`, { signal });
  }

  async getHistory(projectId, query = {}) {
    const request = readQuery(query, {
      cursor: cursorQuery,
      limit: limitQuery,
      status: stringQuery,
    });
    return this.http.requestJson(withQuery(
      `/v1/projects/${resourceId(projectId, 'projectId')}/history`,
      request.values,
    ), { signal: request.signal });
  }

  async #jsonMutation(path, body, {
    ifMatch = undefined,
    idempotencyKey,
    signal = undefined,
  } = {}, method = 'POST') {
    return this.http.requestJson(path, {
      method,
      signal,
      body,
      headers: {
        'idempotency-key': requiredIdempotencyKey(idempotencyKey),
        ...(ifMatch === undefined ? {} : { 'if-match': quotedRevision(ifMatch) }),
      },
    });
  }

  request(path, options = {}) {
    return this.http.request(path, options);
  }

  requestJson(path, options = {}) {
    return this.http.requestJson(path, options);
  }

  events(options = {}) {
    return new ZipflowEventClient({ httpClient: this.http }).subscribe(options);
  }

  subscribeEvents(options = {}) {
    return this.events(options);
  }

  assertCompatibility(value) {
    const apiVersion = typeof value?.apiVersion === 'string' ? value.apiVersion : '';
    const apiMajor = Number(apiVersion.split('.', 1)[0]);
    if (apiMajor !== this.expectedApiMajor) {
      throw new ZipflowCompatibilityError('API_INCOMPATIBLE',
        `Zipflow API ${apiVersion || 'unknown'} is incompatible with client major ${this.expectedApiMajor}.`,
        { apiVersion, expectedApiMajor: this.expectedApiMajor });
    }
    const revision = value?.schemaRevision;
    if (!Number.isInteger(revision)
      || revision < this.minimumSchemaRevision
      || revision > this.maximumSchemaRevision) {
      throw new ZipflowCompatibilityError('API_INCOMPATIBLE',
        `Zipflow schema revision ${String(revision)} is outside the supported range.`, {
          schemaRevision: revision,
          minimumSchemaRevision: this.minimumSchemaRevision,
          maximumSchemaRevision: this.maximumSchemaRevision,
        });
    }
    const capabilities = Array.isArray(value?.capabilities) ? value.capabilities : [];
    const missing = this.requiredCapabilities.filter((capability) => !capabilities.includes(capability));
    if (missing.length > 0) {
      throw new ZipflowCompatibilityError('CAPABILITY_MISSING',
        `Zipflow is missing required capabilities: ${missing.join(', ')}.`, { missingCapabilities: missing });
    }
    return value;
  }
}

export function createZipflowClient(options) {
  return new ZipflowClient(options);
}

function uniqueStrings(values, name) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value)) {
    throw new TypeError(`${name} must be an array of non-empty strings.`);
  }
  return Object.freeze([...new Set(values)]);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function requiredHeaderValue(value, name) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) {
    throw new TypeError(`${name} must be a non-empty HTTP header value.`);
  }
  return value;
}

function requiredIdempotencyKey(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value)) {
    throw new TypeError('idempotencyKey must contain 1 to 256 visible ASCII characters.');
  }
  return value;
}

function requiredObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object.`);
  }
  return value;
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must be a non-empty safe string.`);
  }
  return value;
}

function resourceId(value, name) {
  const identifier = requiredText(value, name);
  if (identifier.length > 512 || !identifier.trim() || identifier === '.' || identifier === '..') {
    throw new TypeError(`${name} must be a non-empty identifier of at most 512 characters.`);
  }
  return encodeComponent(identifier, name);
}

function quotedRevision(value) {
  const source = typeof value === 'number' ? String(value) : String(value ?? '');
  const match = /^(?:"(0|[1-9]\d*)"|(0|[1-9]\d*))$/.exec(source);
  if (!match) throw new TypeError('ifMatch must be a non-negative workflow or surface revision.');
  const revision = Number(match[1] ?? match[2]);
  if (!Number.isSafeInteger(revision)) throw new TypeError('ifMatch must be a safe integer revision.');
  return `"${revision}"`;
}

function readQuery(value, definitions) {
  const query = value === undefined ? {} : requiredObject(value, 'query');
  const allowed = new Set([...Object.keys(definitions), 'signal']);
  for (const name of Object.keys(query)) {
    if (!allowed.has(name)) throw new TypeError(`Unsupported query option: ${name}`);
  }
  const values = [];
  for (const [name, normalize] of Object.entries(definitions)) {
    if (query[name] === undefined || query[name] === null) continue;
    values.push([name, normalize(query[name], name)]);
  }
  return { values, signal: query.signal };
}

function stringQuery(value, name) {
  return requiredText(value, name);
}

function cursorQuery(value, name) {
  const cursor = requiredText(value, name);
  if (cursor.length > 8192) throw new TypeError(`${name} exceeds 8192 characters.`);
  return cursor;
}

function limitQuery(value, name) {
  const limit = typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return String(limit);
}

function withQuery(path, entries) {
  if (!entries.length) return path;
  return `${path}?${entries.map(([name, value]) => (
    `${encodeComponent(name, 'query name')}=${encodeComponent(value, name)}`
  )).join('&')}`;
}

function encodeComponent(value, name) {
  try {
    return encodeURIComponent(value);
  } catch {
    throw new TypeError(`${name} contains invalid Unicode.`);
  }
}
