import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LocalLlmError } from './errors.js';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const DEFAULT_CODEX_ENDPOINT = 'unix://';
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export async function connectCodexWebSocket(endpoint, {
  token = '',
  signal = null,
  timeoutMs = 15_000,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  netConnect = net.connect,
  tlsConnect = tls.connect,
} = {}) {
  const target = parseCodexEndpoint(endpoint);
  if (target.transport === 'stdio') {
    throw new LocalLlmError('stdio:// uses the local Codex process transport.', {
      code: 'invalid_endpoint', provider: 'codex',
    });
  }
  if (signal?.aborted) throw cancelledError();

  const socket = target.transport === 'wss'
    ? tlsConnect({ host: target.host, port: target.port, ...(net.isIP(target.host) ? {} : { servername: target.host }) })
    : target.transport === 'ws'
      ? netConnect({ host: target.host, port: target.port })
      : netConnect(target.socketPath);

  const connection = new CodexWebSocketConnection(socket, { maxMessageBytes });
  await connection.handshake(target, { token, signal, timeoutMs });
  return connection;
}

export function parseCodexEndpoint(value) {
  const endpoint = String(value ?? '').trim() || DEFAULT_CODEX_ENDPOINT;
  if (endpoint === 'stdio://') return { endpoint, transport: 'stdio' };
  if (endpoint === 'unix://') {
    return {
      endpoint,
      transport: 'unix',
      socketPath: defaultCodexSocketPath(),
      requestPath: '/',
      hostHeader: 'localhost',
    };
  }
  if (endpoint.startsWith('unix://')) {
    const socketPath = endpoint.slice('unix://'.length);
    if (!socketPath.startsWith('/')) throw invalidEndpoint('A custom Unix socket must use an absolute path, for example unix:///tmp/codex.sock.');
    return {
      endpoint: `unix://${path.normalize(socketPath)}`,
      transport: 'unix',
      socketPath: path.normalize(socketPath),
      requestPath: '/',
      hostHeader: 'localhost',
    };
  }

  let parsed;
  try { parsed = new URL(endpoint); } catch { throw invalidEndpoint('Enter stdio://, ws://, wss://, unix://, or unix:///absolute/path.'); }
  if (!['ws:', 'wss:'].includes(parsed.protocol)) throw invalidEndpoint('The Codex endpoint must use stdio://, ws://, wss://, or unix://.');
  if (!parsed.hostname) throw invalidEndpoint('The Codex WebSocket endpoint must include a host.');
  if (parsed.protocol === 'ws:' && !isLoopbackHost(parsed.hostname)) {
    throw invalidEndpoint('Plain ws:// Codex endpoints are allowed only on localhost. Use wss:// or an SSH port forward for remote servers.');
  }
  if (parsed.username || parsed.password) throw invalidEndpoint('Put WebSocket credentials in the Authentication field, not in the endpoint URL.');
  if (parsed.hash) throw invalidEndpoint('The Codex endpoint cannot contain a URL fragment.');
  const secure = parsed.protocol === 'wss:';
  return {
    endpoint: parsed.toString(),
    transport: secure ? 'wss' : 'ws',
    host: parsed.hostname,
    port: Number(parsed.port || (secure ? 443 : 80)),
    requestPath: `${parsed.pathname || '/'}${parsed.search}`,
    hostHeader: parsed.port ? `${formatHost(parsed.hostname)}:${parsed.port}` : formatHost(parsed.hostname),
  };
}

export function codexEndpointDisplayValue(value = DEFAULT_CODEX_ENDPOINT) {
  const target = parseCodexEndpoint(value);
  if (target.transport === 'stdio') return 'stdio://';
  if (target.transport === 'unix') return `unix://${target.socketPath}`;
  return target.endpoint;
}

export function normalizeCodexEndpoint(value) {
  const target = parseCodexEndpoint(value);
  if (target.transport === 'stdio') return 'stdio://';
  if (target.transport === 'unix') {
    return target.endpoint === 'unix://' ? 'unix://' : `unix://${target.socketPath}`;
  }
  const parsed = new URL(target.endpoint);
  parsed.hash = '';
  return parsed.toString();
}

export function codexEndpointUsesRemoteTransport(value) {
  try { return parseCodexEndpoint(value).transport !== 'stdio'; } catch { return false; }
}

class CodexWebSocketConnection extends EventEmitter {
  constructor(socket, { maxMessageBytes }) {
    super();
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.open = false;
    this.closed = false;
  }

  handshake(target, { token, signal, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      let responseBuffer = Buffer.alloc(0);
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.socket.removeListener('connect', onConnect);
        this.socket.removeListener('secureConnect', onConnect);
        this.socket.removeListener('data', onHandshakeData);
        this.socket.removeListener('error', onHandshakeError);
        if (error) {
          this.socket.destroy();
          reject(error);
        } else {
          this.open = true;
          this.attachRuntimeListeners();
          resolve(this);
        }
      };
      const onAbort = () => finish(cancelledError());
      const onHandshakeError = (error) => finish(new LocalLlmError(
        `Could not connect to Codex app-server at ${target.endpoint}: ${error.message}`,
        { code: 'connection_failed', provider: 'codex', cause: error },
      ));
      const onConnect = () => {
        const headers = [
          `GET ${target.requestPath || '/'} HTTP/1.1`,
          `Host: ${target.hostHeader}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
        ];
        if (token) headers.push(`Authorization: Bearer ${token}`);
        this.socket.write(`${headers.join('\r\n')}\r\n\r\n`);
      };
      const onHandshakeData = (chunk) => {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        if (responseBuffer.length > 64 * 1024) return finish(protocolError('Codex WebSocket handshake headers are too large.'));
        const headerEnd = responseBuffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const headerText = responseBuffer.subarray(0, headerEnd).toString('latin1');
        const lines = headerText.split('\r\n');
        const status = lines.shift() || '';
        if (!/^HTTP\/1\.[01] 101\b/.test(status)) return finish(protocolError(`Codex WebSocket handshake failed: ${status || 'invalid response'}.`));
        const headers = new Map(lines.map((line) => {
          const index = line.indexOf(':');
          return index < 0 ? [line.toLowerCase(), ''] : [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
        }));
        const expectedAccept = crypto.createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
        if (headers.get('sec-websocket-accept') !== expectedAccept) return finish(protocolError('Codex WebSocket handshake returned an invalid Sec-WebSocket-Accept value.'));
        const remainder = responseBuffer.subarray(headerEnd + 4);
        if (remainder.length) this.buffer = Buffer.concat([this.buffer, remainder]);
        finish(null);
        if (remainder.length) this.parseFrames();
      };
      const timer = setTimeout(() => finish(new LocalLlmError(
        `Timed out connecting to Codex app-server at ${target.endpoint}.`,
        { code: 'connection_timeout', provider: 'codex' },
      )), timeoutMs);

      signal?.addEventListener('abort', onAbort, { once: true });
      this.socket.on('data', onHandshakeData);
      this.socket.once('error', onHandshakeError);
      if (target.transport === 'wss') this.socket.once('secureConnect', onConnect);
      else this.socket.once('connect', onConnect);
      if (signal?.aborted) onAbort();
    });
  }

  attachRuntimeListeners() {
    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parseFrames();
    });
    this.socket.on('error', (error) => {
      if (this.closed) return;
      this.emit('error', new LocalLlmError(`Codex WebSocket connection failed: ${error.message}`, {
        code: 'connection_failed', provider: 'codex', cause: error,
      }));
    });
    this.socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.open = false;
      this.emit('close');
    });
  }

  send(text) {
    if (!this.open || this.closed || !this.socket.writable) throw new LocalLlmError(
      'Codex app-server WebSocket is unavailable.',
      { code: 'app_server_closed', provider: 'codex' },
    );
    this.socket.write(encodeClientFrame(0x1, Buffer.from(String(text), 'utf8')));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    try {
      if (this.socket.writable) {
        this.socket.end(encodeClientFrame(0x8, Buffer.alloc(0)));
        return;
      }
    } catch {}
    this.socket.end();
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high !== 0) return this.fail(protocolError('Codex WebSocket frame exceeds the supported size.'));
        length = low;
        offset = 10;
      }
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      if (opcode >= 0x8 && (!fin || payload.length > 125)) return this.fail(protocolError('Codex WebSocket sent an invalid control frame.'));
      if (opcode === 0x8) {
        this.closed = true;
        this.open = false;
        this.socket.end();
        this.emit('close');
        return;
      }
      if (opcode === 0x9) {
        if (this.socket.writable) this.socket.write(encodeClientFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) continue;
      if (![0x0, 0x1].includes(opcode)) return this.fail(protocolError('Codex WebSocket sent an unsupported binary frame.'));
      if (opcode === 0x1) {
        if (this.fragmentOpcode !== null) return this.fail(protocolError('Codex WebSocket started a new message before finishing the previous one.'));
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
      } else {
        if (this.fragmentOpcode === null) return this.fail(protocolError('Codex WebSocket sent an unexpected continuation frame.'));
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
      }
      if (this.fragmentBytes > this.maxMessageBytes) return this.fail(protocolError('Codex WebSocket message exceeded the configured size limit.'));
      if (!fin) continue;
      const message = Buffer.concat(this.fragments, this.fragmentBytes).toString('utf8');
      this.fragmentOpcode = null;
      this.fragments = [];
      this.fragmentBytes = 0;
      this.emit('message', message);
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.socket.destroy();
    this.emit('error', error);
  }
}

function encodeClientFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function defaultCodexSocketPath() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'app-server-control', 'app-server-control.sock');
}

function isLoopbackHost(hostname) {
  const value = String(hostname ?? '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

function formatHost(hostname) {
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

function invalidEndpoint(message) {
  return new LocalLlmError(message, { code: 'invalid_endpoint', provider: 'codex' });
}

function protocolError(message) {
  return new LocalLlmError(message, { code: 'protocol_error', provider: 'codex' });
}

function cancelledError() {
  return new LocalLlmError('Codex app-server request cancelled.', { code: 'cancelled', provider: 'codex' });
}
