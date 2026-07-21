import { Box, Text, color, renderTextEditorLines } from 'terlio.js';

export function ZipflowTextEditorView({
  title = ' Editor ',
  value = '',
  cursor = 0,
  width = 80,
  height = 8,
  placeholder = '',
  lineNumbers = true,
  theme = null,
} = {}) {
  const empty = String(value ?? '').length === 0;
  const lines = renderTextEditorLines({
    value,
    cursor,
    width: Math.max(8, width - 4),
    height,
    placeholder,
    lineNumbers,
  });
  return Box({
    border: true,
    borderColor: theme?.borderActive ?? theme?.border,
    padding: { left: 1, right: 1 },
    title,
  }, ...lines.map((line) => Text(empty && placeholder ? color(theme, 'textMuted', line) : line, { wrap: false })));
}
