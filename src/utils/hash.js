import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function hashText(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export async function hashFile(target, { signal = null } = {}) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(target);
    const abort = () => stream.destroy(Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' }));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => { signal?.removeEventListener('abort', abort); reject(error); });
    stream.on('end', () => { signal?.removeEventListener('abort', abort); resolve(); });
  });
  return hash.digest('hex');
}

export function shortToken(bytes = 3) {
  return randomBytes(bytes).toString('hex').toUpperCase();
}
