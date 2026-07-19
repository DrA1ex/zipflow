import { shortToken } from './hash.js';

export function createRunId(date = new Date()) {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
  return `zf-${stamp}-${shortToken(2)}`;
}
