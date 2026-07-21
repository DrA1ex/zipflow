import { Column, Text, color, truncateVisible, wrapText } from 'terlio.js';

export function ContextDock({ text = '', rows = 1, width = 80, theme = null, token = 'textMuted' } = {}) {
  const safeRows = Math.max(0, Number(rows) || 0);
  if (!safeRows) return null;
  const safeWidth = Math.max(12, Number(width) || 80);
  const source = String(text ?? '').trim();
  const wrapped = source ? wrapText(source, safeWidth) : [];
  const clipped = wrapped.slice(0, safeRows);
  if (wrapped.length > safeRows && clipped.length) {
    clipped[clipped.length - 1] = truncateVisible(clipped.at(-1), Math.max(1, safeWidth - 1), '…');
  }
  while (clipped.length < safeRows) clipped.push('');
  return Column({ height: safeRows }, ...clipped.map((line) => Text(line ? color(theme, token, line) : '', { wrap: false })));
}

export function contextText(item) {
  return String(item?.context ?? item?.description ?? '').trim();
}
