import http from 'node:http';
import {
  API_MAJOR_VERSION,
  CAPABILITIES,
  MAX_SCHEMA_REVISION,
  MIN_SCHEMA_REVISION,
  PROTOCOL_PATHS,
} from '../protocol/index.js';

export function probeExistingServer({
  endpoint,
  token,
  timeoutMs = 300,
  requestImpl = http.request,
} = {}) {
  return new Promise((resolve) => {
    let request;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ reachable: false, compatible: false }), timeoutMs);
    try {
      request = requestImpl({
        socketPath: endpoint.listenPath,
        path: PROTOCOL_PATHS.hello,
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 256 * 1024) {
            response.destroy();
            finish({ reachable: true, compatible: false });
          } else chunks.push(chunk);
        });
        response.once('error', () => finish({ reachable: true, compatible: false }));
        response.once('end', () => {
          if (response.statusCode !== 200) {
            finish({ reachable: true, compatible: false });
            return;
          }
          const hello = parseJson(Buffer.concat(chunks, size).toString('utf8'));
          finish({
            reachable: true,
            compatible: compatibleHello(hello),
            hello,
          });
        });
      });
      request.once('error', () => finish({ reachable: false, compatible: false }));
      request.end();
    } catch {
      finish({ reachable: false, compatible: false });
    }
  });
}

function compatibleHello(hello) {
  const major = Number(String(hello?.apiVersion ?? '').split('.', 1)[0]);
  const revision = hello?.schemaRevision;
  const capabilities = Array.isArray(hello?.capabilities) ? hello.capabilities : [];
  return major === API_MAJOR_VERSION
    && Number.isInteger(revision)
    && revision >= MIN_SCHEMA_REVISION
    && revision <= MAX_SCHEMA_REVISION
    && CAPABILITIES.every((capability) => capabilities.includes(capability));
}

function parseJson(source) {
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}
