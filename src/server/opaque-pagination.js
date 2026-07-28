import { createHash, timingSafeEqual } from 'node:crypto';

const CURSOR_VERSION = 1;
const CURSOR_DOMAIN = 'zipflow-server-cursor-v1';
const MAX_CURSOR_BYTES = 2048;

export function paginateOpaque(items, {
  resource,
  scope,
  snapshot,
  cursor = null,
  limit = null,
  defaultLimit = 25,
  maxLimit = 100,
} = {}) {
  if (!Array.isArray(items)) throw new TypeError('Pagination items must be an array.');
  validateContext(resource, scope, snapshot);
  const pageLimit = normalizeLimit(limit, defaultLimit, maxLimit);
  const offset = cursor == null || cursor === ''
    ? 0
    : decodeCursor(cursor, { resource, scope, snapshot });
  if (offset > items.length) throw cursorError('Cursor offset is outside this resource.');
  const pageItems = items.slice(offset, offset + pageLimit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    page: {
      limit: pageLimit,
      total: items.length,
      nextCursor: nextOffset < items.length
        ? encodeCursor({ resource, scope, snapshot, offset: nextOffset })
        : null,
    },
  };
}

export function encodeCursor({ resource, scope, snapshot, offset }) {
  validateContext(resource, scope, snapshot);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Cursor offset is invalid.');
  const payload = Buffer.from(JSON.stringify({
    version: CURSOR_VERSION,
    resource,
    scope,
    snapshot,
    offset,
  })).toString('base64url');
  return `${payload}.${checksum(payload)}`;
}

export function decodeCursor(value, expected) {
  validateContext(expected?.resource, expected?.scope, expected?.snapshot);
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > MAX_CURSOR_BYTES) {
    throw cursorError('Cursor is invalid.');
  }
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!match || !sameChecksum(match[2], checksum(match[1]))) throw cursorError('Cursor is invalid.');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    throw cursorError('Cursor is invalid.');
  }
  if (
    payload?.version !== CURSOR_VERSION
    || payload.resource !== expected.resource
    || payload.scope !== expected.scope
    || payload.snapshot !== expected.snapshot
    || !Number.isSafeInteger(payload.offset)
    || payload.offset < 0
  ) {
    throw cursorError('Cursor does not belong to this resource revision.');
  }
  return payload.offset;
}

function normalizeLimit(limit, defaultLimit, maxLimit) {
  if (!Number.isSafeInteger(maxLimit) || maxLimit < 1) throw new TypeError('Server page maximum is invalid.');
  if (!Number.isSafeInteger(defaultLimit) || defaultLimit < 1) throw new TypeError('Default page size is invalid.');
  if (limit == null || limit === '') return Math.min(defaultLimit, maxLimit);
  const numeric = typeof limit === 'string' && /^\d+$/.test(limit) ? Number(limit) : limit;
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw Object.assign(new Error('Page limit must be a positive integer.'), {
      code: 'INVALID_PAGE_LIMIT', status: 400, expose: true,
    });
  }
  return Math.min(numeric, maxLimit);
}

function validateContext(resource, scope, snapshot) {
  for (const [label, value] of [['resource', resource], ['scope', scope], ['snapshot', snapshot]]) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
      throw new TypeError(`Cursor ${label} is invalid.`);
    }
  }
}

function checksum(payload) {
  return createHash('sha256').update(CURSOR_DOMAIN).update('\0').update(payload).digest('base64url').slice(0, 22);
}

function sameChecksum(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cursorError(message) {
  return Object.assign(new Error(message), {
    code: 'INVALID_CURSOR', status: 400, expose: true,
  });
}
