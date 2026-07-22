import { Column, Text, color, truncateVisible, visibleLength, wrapText } from 'terlio.js';

export function ContextDock({ text = '', rows = 1, width = 80, theme = null, token = 'text' } = {}) {
  const safeRows = Math.max(0, Number(rows) || 0);
  if (!safeRows) return null;
  const safeWidth = Math.max(12, Number(width) || 80);
  const source = String(text ?? '').trim();
  const prefix = source ? '› ' : '';
  const available = Math.max(8, safeWidth - visibleLength(prefix));
  const explicitLines = source ? source.split(/\r?\n/).map((line) => line.trim()) : [];
  const preserveExplicitRows = explicitLines.length > 1;
  let truncated = false;
  const wrapped = preserveExplicitRows
    ? explicitLines.map((line) => {
      const lines = wrapText(line, available);
      if (lines.length > 1) truncated = true;
      return lines[0] ?? '';
    })
    : source ? wrapText(source, available) : [];
  const clipped = wrapped.slice(0, safeRows);
  truncated ||= wrapped.length > safeRows;
  if (truncated && clipped.length) {
    const hint = '  [? full help]';
    clipped[clipped.length - 1] = `${truncateVisible(clipped.at(-1), Math.max(1, available - visibleLength(hint) - 1), '…')}${hint}`;
  }
  while (clipped.length < safeRows) clipped.push('');
  return Column({ height: safeRows }, ...clipped.map((line, index) => {
    if (!line) return Text('', { wrap: false });
    const hintIndex = line.lastIndexOf('  [? full help]');
    const content = hintIndex >= 0 ? line.slice(0, hintIndex) : line;
    const hint = hintIndex >= 0 ? line.slice(hintIndex) : '';
    return Text(`${index === 0 ? color(theme, 'accent', prefix) : '  '}${color(theme, token, content)}${hint ? color(theme, 'accent', hint) : ''}`, { wrap: false });
  }));
}

export function contextText(item) {
  return String(item?.context ?? item?.description ?? '').trim();
}
