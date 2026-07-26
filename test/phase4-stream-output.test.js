import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCompletion } from '../src/llm/client.js';
import { listLmStudioModelRecords } from '../src/llm/model-info.js';
import { runProcess } from '../src/utils/process.js';
import { BoundedByteBuffer, ByteChunkCollector } from '../src/utils/byte-buffer.js';

function completionRequest() {
  return {
    provider: 'ollama', model: 'fixture', messages: [], responseSchema: null,
  };
}

function streamResponse(chunks, { close = true, intervalMs = 0 } = {}) {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new Response(new ReadableStream({
    start(controller) {
      let index = 0;
      const emit = () => {
        if (cancelled) return;
        if (index >= chunks.length) {
          if (close) controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index++]));
        if (intervalMs > 0) setTimeout(emit, intervalMs);
        else queueMicrotask(emit);
      };
      emit();
    },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function openAiEvent(content = '', reasoning = '') {
  return `data: ${JSON.stringify({ choices: [{ delta: { content, reasoning_content: reasoning } }] })}\n\n`;
}

function rejectingFetchOnAbort(_url, { signal }) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

test('LLM connection timeout is independent and typed', async () => {
  await assert.rejects(
    createLocalCompletion(completionRequest(), {
      fetchImpl: rejectingFetchOnAbort,
      connectionTimeoutMs: 20,
      totalDeadlineMs: 500,
    }),
    (error) => error.code === 'llm_connection_timeout' && /connection/i.test(error.message),
  );
});

test('LLM stream that opens and stalls is cancelled by the idle deadline', async () => {
  const response = streamResponse([openAiEvent('started')], { close: false });
  await assert.rejects(
    createLocalCompletion(completionRequest(), {
      fetchImpl: async () => response,
      idleTimeoutMs: 25,
      totalDeadlineMs: 500,
    }),
    (error) => error.code === 'llm_idle_timeout' && /no data/i.test(error.message),
  );
});

test('LLM total deadline cancels a stream that keeps producing chunks', async () => {
  const encoder = new TextEncoder();
  let timer = null;
  const response = new Response(new ReadableStream({
    start(controller) {
      timer = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), 5);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(
    createLocalCompletion(completionRequest(), {
      fetchImpl: async () => response,
      idleTimeoutMs: 200,
      totalDeadlineMs: 35,
    }),
    (error) => error.code === 'llm_total_timeout' && /total deadline/i.test(error.message),
  );
});


test('HTTP error bodies remain subject to the total request deadline', async () => {
  const fetchImpl = async (_url, { signal }) => {
    let bodyController = null;
    const body = new ReadableStream({ start(controller) { bodyController = controller; } });
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      bodyController.error(error);
    }, { once: true });
    return new Response(body, { status: 500, headers: { 'Content-Type': 'text/plain' } });
  };
  await assert.rejects(
    createLocalCompletion(completionRequest(), {
      fetchImpl,
      connectionTimeoutMs: 100,
      totalDeadlineMs: 25,
    }),
    (error) => error.code === 'llm_total_timeout',
  );
});

test('non-streaming JSON and HTTP error bodies are byte bounded', async () => {
  await assert.rejects(
    createLocalCompletion(completionRequest(), {
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'x'.repeat(256) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      streamLimits: { maxAnswerBytes: 16, maxReasoningBytes: 16, maxSseEventBytes: 32 },
    }),
    (error) => error.code === 'llm_response_too_large' && /completion response exceeded/i.test(error.message),
  );

  await assert.rejects(
    createLocalCompletion(completionRequest(), {
      fetchImpl: async () => new Response('x'.repeat(256), { status: 500 }),
      streamLimits: { maxRawResponseBytes: 64 },
    }),
    (error) => error.code === 'llm_response_too_large' && /error response exceeded/i.test(error.message),
  );
});

test('model metadata JSON uses the same idle and response-size bounds', async () => {
  const stalled = new Response(new ReadableStream({ start() {} }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  await assert.rejects(
    listLmStudioModelRecords({
      fetchImpl: async () => stalled,
      streamLimits: { idleTimeoutMs: 20, totalDeadlineMs: 500 },
    }),
    (error) => error.code === 'llm_idle_timeout',
  );

  await assert.rejects(
    listLmStudioModelRecords({
      fetchImpl: async () => new Response(JSON.stringify({
        models: [{ type: 'llm', key: 'x'.repeat(256) }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      streamLimits: { maxRawResponseBytes: 64 },
    }),
    (error) => error.code === 'llm_response_too_large' && /JSON response exceeded/i.test(error.message),
  );
});

test('SSE event and unparsed-buffer byte limits fail with distinct typed errors', async () => {
  const oversized = `data: ${'x'.repeat(128)}\n\n`;
  await assert.rejects(
    createLocalCompletion(completionRequest(), {
      fetchImpl: async () => streamResponse([oversized]),
      streamLimits: { maxSseEventBytes: 64, maxUnparsedBufferBytes: 256 },
    }),
    (error) => error.code === 'sse_event_too_large' && /event exceeded/i.test(error.message),
  );

  await assert.rejects(
    createLocalCompletion(completionRequest(), {
      fetchImpl: async () => streamResponse([`data: ${'y'.repeat(96)}`]),
      streamLimits: { maxSseEventBytes: 256, maxUnparsedBufferBytes: 64 },
    }),
    (error) => error.code === 'sse_buffer_too_large' && /unparsed/i.test(error.message),
  );
});

test('answer and reasoning limits are enforced by UTF-8 bytes', async () => {
  await assert.rejects(
    createLocalCompletion(completionRequest(), {
      fetchImpl: async () => streamResponse([openAiEvent('😀😀')]),
      streamLimits: { maxAnswerBytes: 7 },
    }),
    (error) => error.code === 'llm_output_too_large' && /answer output/i.test(error.message),
  );

  await assert.rejects(
    createLocalCompletion(completionRequest(), {
      fetchImpl: async () => streamResponse([openAiEvent('', '😀😀')]),
      streamLimits: { maxReasoningBytes: 7 },
    }),
    (error) => error.code === 'llm_output_too_large' && /reasoning output/i.test(error.message),
  );
});

test('normal long responses stream as deltas and retain only bounded raw SSE data', async () => {
  const pieces = Array.from({ length: 200 }, (_, index) => `${index}:😀;`);
  const events = [];
  const completion = await createLocalCompletion(completionRequest(), {
    fetchImpl: async () => streamResponse(pieces.map((piece) => openAiEvent(piece))),
    streamLimits: {
      maxAnswerBytes: 64 * 1024,
      maxRawResponseBytes: 256,
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(completion.content, pieces.join(''));
  assert.equal(completion.contentBytes, Buffer.byteLength(pieces.join('')));
  assert.equal(completion.rawResponseTruncated, true);
  assert.ok(Buffer.byteLength(completion.rawResponse) <= 256);
  const chunks = events.filter((event) => event.type === 'chunk');
  assert.equal(chunks.length, pieces.length);
  assert.ok(chunks.every((event) => Object.hasOwn(event, 'contentDelta')));
  assert.ok(chunks.every((event) => !Object.hasOwn(event, 'content')));
});


test('bounded buffers keep fixed-size segments and never expose split UTF-8 boundaries', () => {
  const ring = new BoundedByteBuffer(1_024, { segmentBytes: 64 });
  for (let index = 0; index < 20_000; index += 1) ring.append(Buffer.from([0x61 + (index % 20)]));
  assert.equal(ring.byteLength, 1_024);
  assert.equal(ring.truncated, true);
  assert.ok(ring.segments.length - ring.head <= 17);

  const unicode = new BoundedByteBuffer(17, { segmentBytes: 8 });
  for (let index = 0; index < 20; index += 1) unicode.append('😀');
  assert.doesNotMatch(unicode.toString(), /�/);
  assert.ok(Buffer.byteLength(unicode.toString()) <= 17);

  const collector = new ByteChunkCollector(10_000, { segmentBytes: 128 });
  for (let index = 0; index < 10_000; index += 1) collector.append('x');
  assert.equal(collector.toString().length, 10_000);
  assert.ok(collector.segments.length <= 79);

  const encoded = new TextEncoder().encode('{"ok":true}');
  const bytes = new ByteChunkCollector(64);
  bytes.append(encoded);
  assert.equal(bytes.toString(), '{"ok":true}');
});

test('process output uses a byte-bounded UTF-8 tail and throttles updates', async () => {
  let updates = 0;
  const result = await runProcess(process.execPath, ['-e', [
    "let i=0;",
    "const write=()=>{ if(i++>=2000) return; process.stdout.write('😀'+i+'\\n'); setImmediate(write); };",
    'write();',
  ].join('')], {
    outputLimit: 1024,
    outputUpdateIntervalMs: 25,
    onOutput: () => { updates += 1; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(result.stdoutBytes <= 1024);
  assert.ok(Buffer.byteLength(result.stdout) <= 1024);
  assert.match(result.stdout, /earlier output truncated/);
  assert.doesNotMatch(result.stdout, /�/);
  assert.ok(updates > 0 && updates < 2000, `expected throttled updates, received ${updates}`);
});
