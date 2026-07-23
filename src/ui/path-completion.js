import { SelectList } from 'terlio.js';
import { selectRowIndex, selectRows } from './select-rows.js';
import { translateForState as t } from '../i18n/index.js';
import { wheelScrollDelta } from './wheel.js';

export function PathCompletionPopup({ state, height, theme }) {
  const completion = state.pathSuggestions;
  if (!completion?.items?.length || !state.pathSuggestionActive) return null;
  const rows = selectRows(completion.items, (item) => `${item.detail || (item.isDirectory ? 'DIR' : 'ZIP')}  ${item.label}`);
  return SelectList({
    title: t(state, 'Path suggestions'),
    items: rows,
    selectedIndex: completion.selectedIndex ?? 0,
    windowSize: Math.max(1, Math.min(6, Number(height) - 2 || 4)),
    getLabel: (item) => item.label,
    wrapItems: false,
    maxItemLines: 1,
    theme,
    pointerId: 'zipflow:path-suggestions',
    onSelect: (item, index) => state.dispatch?.({ type: 'path-select', index: selectRowIndex(item, index) }),
    onWheel: (event) => {
      const delta = wheelScrollDelta(event);
      if (delta) state.dispatch?.({ type: 'path-move', delta, wrap: false });
      event.preventDefault();
      event.stopPropagation?.();
    },
  });
}
