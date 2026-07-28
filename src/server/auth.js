import { timingSafeEqual } from 'node:crypto';

export function authenticateRequest(request, token) {
  const supplied = readBearerToken(request?.headers?.authorization);
  if (!supplied || !constantTimeTextEqual(supplied, token)) {
    throw authenticationError();
  }
  return true;
}

export function readBearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  return match?.[1] ?? null;
}

export function constantTimeTextEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) {
    const padding = Buffer.alloc(Math.max(leftBytes.length, rightBytes.length));
    const paddedLeft = Buffer.concat([leftBytes, padding]).subarray(0, padding.length);
    const paddedRight = Buffer.concat([rightBytes, padding]).subarray(0, padding.length);
    timingSafeEqual(paddedLeft, paddedRight);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export function authenticationError() {
  return Object.assign(new Error('Authentication is required.'), {
    name: 'AuthenticationError',
    code: 'AUTHENTICATION_REQUIRED',
    status: 401,
    expose: true,
    headers: {
      'www-authenticate': 'Bearer realm="zipflow-local"',
    },
  });
}
