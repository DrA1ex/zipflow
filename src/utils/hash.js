import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function hashText(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export async function hashFile(target) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function shortToken(bytes = 3) {
  return randomBytes(bytes).toString('hex').toUpperCase();
}
