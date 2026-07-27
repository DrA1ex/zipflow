import { copyTextToClipboard } from 'terlio.js';

export function normalizeClipboardResult(result) {
  if (typeof result === 'boolean') return result;
  return result?.copied === true;
}

export function copyZipflowText(text, { output, copyImpl = copyTextToClipboard } = {}) {
  const result = copyImpl(text, {
    output,
    clipboardPolicy: 'auto',
  });
  if (result && typeof result.then === 'function') {
    return result.then(normalizeClipboardResult);
  }
  return normalizeClipboardResult(result);
}
