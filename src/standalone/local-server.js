import { ZipflowClient } from '../client/index.js';
import { startZipflowServer } from '../server/server.js';
import {
  createRuntimeSecurity,
  resolveServerPaths,
} from '../server/runtime-paths.js';

export class StandaloneServerConnection {
  constructor({
    client,
    server,
    owned,
    endpoint,
    hello,
  }) {
    this.client = client;
    this.server = server;
    this.owned = owned;
    this.endpoint = endpoint;
    this.hello = hello;
    this.closed = false;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.client?.close?.();
    if (this.owned) await this.server?.close?.();
  }
}

export async function connectStandaloneServer({
  paths = resolveServerPaths(),
  security = createRuntimeSecurity(paths),
  startServer = startZipflowServer,
  clientFactory = (options) => new ZipflowClient(options),
  idleTimeoutMs = 0,
} = {}) {
  const server = await startServer({ paths, security, idleTimeoutMs });
  const owned = server.reused !== true;
  try {
    const token = owned
      ? requiredToken(server.token)
      : requiredToken(await security.readPrivateFile(paths.tokenPath));
    const endpoint = server.discovery?.socketPath ?? paths.endpoint.socketPath;
    const client = await clientFactory({
      endpoint: {
        kind: paths.endpoint.kind,
        socketPath: endpoint,
      },
      token,
    });
    const hello = await client.hello();
    return new StandaloneServerConnection({
      client,
      server,
      owned,
      endpoint,
      hello,
    });
  } catch (error) {
    if (owned) await server.close?.().catch(() => {});
    throw error;
  }
}

function requiredToken(value) {
  const token = String(value ?? '').trim();
  if (token.length < 20 || /[\0\r\n]/.test(token)) {
    throw Object.assign(new Error('The local Zipflow server token is invalid.'), {
      code: 'SERVER_RUNTIME_UNVERIFIED',
    });
  }
  return token;
}
