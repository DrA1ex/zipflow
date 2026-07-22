import path from 'node:path';
import { exists } from './fs.js';
import { runProcess } from './process.js';

export async function revealFile(target) {
  const absolute = path.resolve(String(target ?? ''));
  if (!await exists(absolute)) throw new Error(`File not found: ${absolute}`);
  if (process.platform === 'darwin') return runProcess('open', ['-R', absolute]);
  if (process.platform === 'linux') return runProcess('xdg-open', [path.dirname(absolute)]);
  throw new Error('Opening the containing folder is not supported on this platform.');
}
