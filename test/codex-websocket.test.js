import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import {
  codexEndpointDisplayValue, connectCodexWebSocket, normalizeCodexEndpoint, parseCodexEndpoint,
} from '../src/llm/codex-websocket.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

test('Codex endpoint validation supports stdio, local WebSocket, and Unix sockets', () => {
  assert.equal(normalizeCodexEndpoint(''), 'unix://');
  assert.match(codexEndpointDisplayValue('unix://'), /^unix:\/\/\/.+app-server-control\.sock$/);
  assert.equal(normalizeCodexEndpoint('stdio://'), 'stdio://');
  assert.equal(normalizeCodexEndpoint('ws://127.0.0.1:4500'), 'ws://127.0.0.1:4500/');
  assert.equal(parseCodexEndpoint('unix:///tmp/codex.sock').socketPath, '/tmp/codex.sock');
  assert.throws(() => parseCodexEndpoint('ws://example.com:4500'), /localhost/);
  assert.throws(() => parseCodexEndpoint('http://127.0.0.1:4500'), /must use/);
  assert.throws(() => parseCodexEndpoint('ws://user:secret@127.0.0.1:4500'), /Authentication field/);
});

test('Codex WebSocket client performs an authenticated upgrade and exchanges text frames', async () => {
  let requestHeaders = '';
  let receivedPayload = '';
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        requestHeaders = buffer.subarray(0, end).toString('latin1');
        const key = requestHeaders.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)?.[1]?.trim();
        const accept = crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '', '',
        ].join('\r\n'));
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      if (!upgraded || buffer.length < 2) return;
      const decoded = decodeClientFrame(buffer);
      if (!decoded) return;
      receivedPayload = decoded.payload.toString('utf8');
      buffer = buffer.subarray(decoded.bytes);
      socket.write(encodeServerTextFrame('{"id":1,"result":{"ok":true}}'));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const connection = await connectCodexWebSocket(`ws://127.0.0.1:${address.port}`, { token: 'secret-token' });
  const message = once(connection, 'message');
  connection.send('{"method":"initialize","id":1,"params":{}}');
  const [response] = await message;

  assert.match(requestHeaders, /Authorization: Bearer secret-token/i);
  assert.equal(receivedPayload, '{"method":"initialize","id":1,"params":{}}');
  assert.equal(response, '{"id":1,"result":{"ok":true}}');

  connection.close();
  server.close();
  await once(server, 'close');
});


test('Codex WebSocket client exchanges JSON-RPC frames over a Unix socket', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zipflow-codex-socket-'));
  const socketPath = path.join(root, 'app-server.sock');
  let requestHeaders = '';
  let receivedPayload = '';
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let replied = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        requestHeaders = buffer.subarray(0, end).toString('latin1');
        const key = requestHeaders.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)?.[1]?.trim();
        const accept = crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '', '',
        ].join('\r\n'));
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      if (!upgraded || replied || buffer.length < 2) return;
      const decoded = decodeClientFrame(buffer);
      if (!decoded) return;
      receivedPayload = decoded.payload.toString('utf8');
      buffer = buffer.subarray(decoded.bytes);
      replied = true;
      socket.write(encodeServerTextFrame('{"id":2,"result":{"transport":"unix"}}'));
    });
  });

  try {
    server.listen(socketPath);
    await once(server, 'listening');
    const connection = await connectCodexWebSocket(`unix://${socketPath}`);
    const message = once(connection, 'message');
    connection.send('{"method":"initialize","id":2,"params":{}}');
    const [response] = await message;

    assert.match(requestHeaders, /^GET \/ HTTP\/1\.1/m);
    assert.equal(receivedPayload, '{"method":"initialize","id":2,"params":{}}');
    assert.equal(response, '{"id":2,"result":{"transport":"unix"}}');
    connection.close();
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});

function decodeClientFrame(buffer) {
  const second = buffer[1];
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = buffer.readUInt32BE(6);
    offset = 10;
  }
  if (!(second & 0x80) || buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { payload, bytes: offset + 4 + length };
}

function encodeServerTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length >= 126) throw new Error('Test payload is unexpectedly large.');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}
