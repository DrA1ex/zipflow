import { Box, Text, color, truncateVisible } from 'terlio.js';

export function PathCompletionPopup({ state, width, height, theme }) {
  const completion = state.pathSuggestions;
  if (!completion?.items?.length || !state.pathSuggestionActive) return null;
  const safeWidth = Math.max(28, Number(width) || 60);
  const innerRows = Math.max(2, Math.min(6, Number(height) || 6));
  const selectedIndex = clamp(completion.selectedIndex ?? 0, 0, completion.items.length - 1);
  const windowSize = Math.min(innerRows - 1, completion.items.length);
  const start = Math.min(
    Math.max(selectedIndex - Math.floor(windowSize / 2), 0),
    Math.max(0, completion.items.length - windowSize),
  );
  const visible = completion.items.slice(start, start + windowSize);
  const rows = [Text(color(theme, 'textMuted', `Path suggestions · ${completion.items.length} · ↑/↓ select · Tab/Enter insert`), { wrap: false })];
  for (const [offset, item] of visible.entries()) {
    const index = start + offset;
    const selected = index === selectedIndex;
    const kind = item.isDirectory ? 'DIR' : 'ZIP';
    const label = truncateVisible(`${selected ? '›' : ' '} ${kind.padEnd(3)}  ${item.label}`, Math.max(8, safeWidth - 2), '…');
    const activate = () => state.dispatch?.({ type: 'path-select', index });
    rows.push(Text(color(theme, selected ? 'selected' : 'suggestion', label), {
      wrap: false,
      pointerId: `zipflow:path-suggestion:${index}`,
      pointerData: { suggestionIndex: index },
      onClick: activate,
      onRelease: activate,
    }));
  }
  while (rows.length < innerRows) rows.push(Text('', { wrap: false }));
  return Box({ padding: { left: 1, right: 1 }, height: innerRows }, ...rows);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
