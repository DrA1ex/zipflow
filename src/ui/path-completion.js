import { SelectList } from 'terlio.js';

export function PathCompletionPopup({ state, height, theme }) {
  const completion = state.pathSuggestions;
  if (!completion?.items?.length || !state.pathSuggestionActive) return null;
  return SelectList({
    title: 'Path suggestions',
    items: completion.items,
    selectedIndex: completion.selectedIndex ?? 0,
    windowSize: Math.max(1, Math.min(6, Number(height) - 2 || 4)),
    getLabel: (item) => `${item.isDirectory ? 'DIR' : 'ZIP'}  ${item.label}`,
    getDescription: () => '',
    wrapItems: false,
    maxItemLines: 1,
    theme,
    pointerId: 'zipflow:path-suggestions',
    onSelect: (_item, index) => state.dispatch?.({ type: 'path-select', index }),
  });
}
