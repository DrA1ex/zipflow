const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_SEGMENT_BYTES = 64 * 1024;

export class BoundedByteBuffer {
  constructor(maxBytes = DEFAULT_MAX_BYTES, { segmentBytes = DEFAULT_SEGMENT_BYTES } = {}) {
    this.maxBytes = normalizeLimit(maxBytes);
    this.segmentBytes = Math.max(1, Math.min(normalizeSegmentSize(segmentBytes), Math.max(1, this.maxBytes)));
    this.segments = [];
    this.head = 0;
    this.headOffset = 0;
    this.current = null;
    this.currentLength = 0;
    this.byteLength = 0;
    this.discardedBytes = 0;
  }

  append(value) {
    const chunk = byteChunk(value);
    if (!chunk.length || this.maxBytes === 0) {
      this.discardedBytes += chunk.length;
      return;
    }
    let offset = 0;
    while (offset < chunk.length) {
      this.current ??= Buffer.allocUnsafe(this.segmentBytes);
      const copied = Math.min(chunk.length - offset, this.segmentBytes - this.currentLength);
      chunk.copy(this.current, this.currentLength, offset, offset + copied);
      this.currentLength += copied;
      this.byteLength += copied;
      offset += copied;
      if (this.currentLength === this.segmentBytes) this.flushSegment();
    }
    this.trim();
  }

  trim() {
    let overflow = this.byteLength - this.maxBytes;
    while (overflow > 0 && this.head < this.segments.length) {
      const first = this.segments[this.head];
      const available = first.length - this.headOffset;
      if (available <= overflow) {
        this.segments[this.head] = null;
        this.head += 1;
        this.headOffset = 0;
        this.byteLength -= available;
        this.discardedBytes += available;
        overflow -= available;
      } else {
        this.headOffset += overflow;
        this.byteLength -= overflow;
        this.discardedBytes += overflow;
        overflow = 0;
      }
    }
    if (overflow > 0 && this.currentLength) {
      this.current.copyWithin(0, overflow, this.currentLength);
      this.currentLength -= overflow;
      this.byteLength -= overflow;
      this.discardedBytes += overflow;
    }
    if (this.head >= 1_024 && this.head * 2 >= this.segments.length) {
      this.segments = this.segments.slice(this.head);
      this.head = 0;
    }
  }

  toBuffer() {
    const active = [];
    for (let index = this.head; index < this.segments.length; index += 1) {
      const segment = this.segments[index];
      active.push(index === this.head && this.headOffset ? segment.subarray(this.headOffset) : segment);
    }
    if (this.currentLength) active.push(this.current.subarray(0, this.currentLength));
    if (!active.length) return Buffer.alloc(0);
    if (active.length === 1) return Buffer.from(active[0]);
    return Buffer.concat(active, this.byteLength);
  }

  toString(encoding = 'utf8') {
    const value = this.toBuffer();
    if (encoding !== 'utf8' && encoding !== 'utf-8') return value.toString(encoding);
    return utf8CompleteWindow(value).toString('utf8');
  }

  flushSegment() {
    this.segments.push(this.current);
    this.current = null;
    this.currentLength = 0;
  }

  get truncated() {
    return this.discardedBytes > 0;
  }
}

export class ByteChunkCollector {
  constructor(maxBytes, { label = 'Output', segmentBytes = DEFAULT_SEGMENT_BYTES } = {}) {
    this.maxBytes = normalizeLimit(maxBytes);
    this.label = label;
    this.segmentBytes = Math.max(1, Math.min(normalizeSegmentSize(segmentBytes), Math.max(1, this.maxBytes)));
    this.segments = [];
    this.current = null;
    this.currentLength = 0;
    this.byteLength = 0;
  }

  append(value) {
    const chunk = byteChunk(value);
    const nextBytes = this.byteLength + chunk.length;
    if (nextBytes > this.maxBytes) {
      const error = new Error(`${this.label} exceeded the ${formatBytes(this.maxBytes)} safety limit.`);
      error.code = 'byte_limit_exceeded';
      error.limitBytes = this.maxBytes;
      error.actualBytes = nextBytes;
      throw error;
    }
    let offset = 0;
    while (offset < chunk.length) {
      this.current ??= Buffer.allocUnsafe(this.segmentBytes);
      const copied = Math.min(chunk.length - offset, this.segmentBytes - this.currentLength);
      chunk.copy(this.current, this.currentLength, offset, offset + copied);
      this.currentLength += copied;
      offset += copied;
      if (this.currentLength === this.segmentBytes) this.flushSegment();
    }
    this.byteLength = nextBytes;
  }

  toBuffer() {
    const active = this.currentLength
      ? [...this.segments, this.current.subarray(0, this.currentLength)]
      : this.segments;
    if (!active.length) return Buffer.alloc(0);
    if (active.length === 1) return Buffer.from(active[0]);
    return Buffer.concat(active, this.byteLength);
  }

  toString(encoding = 'utf8') {
    return this.toBuffer().toString(encoding);
  }

  flushSegment() {
    this.segments.push(this.current);
    this.current = null;
    this.currentLength = 0;
  }
}

export function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function utf8CompleteWindow(buffer) {
  let start = 0;
  while (start < buffer.length && isContinuation(buffer[start])) start += 1;
  let end = buffer.length;
  const scanStart = Math.max(start, end - 4);
  for (let index = end - 1; index >= scanStart; index -= 1) {
    if (isContinuation(buffer[index])) continue;
    const expected = utf8SequenceLength(buffer[index]);
    if (expected > 1 && end - index < expected) end = index;
    break;
  }
  return buffer.subarray(start, end);
}

function isContinuation(byte) {
  return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(byte) {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}


function byteChunk(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(String(value ?? ''), 'utf8');
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return DEFAULT_MAX_BYTES;
  return Math.floor(number);
}

function normalizeSegmentSize(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : DEFAULT_SEGMENT_BYTES;
}
