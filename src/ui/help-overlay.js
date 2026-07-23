import { Box, ScrollPane, Text, color, themes, wrapText } from 'terlio.js';
import { translateForState as t } from '../i18n/index.js';
import { wheelScrollDelta } from './wheel.js';

export function openHelpOverlay(controller, { title = 'Help', lines = [] } = {}) {
  const manager = controller.state.overlays;
  if (!manager?.help) return false;
  const view = { scroll: 0, maxScroll: 0 };
  const localizedTitle = t(controller.state, title);
  const source = (Array.isArray(lines) ? lines : [lines]).map((line) => t(controller.state, String(line ?? '')));
  manager.help({
    title: ` ${localizedTitle} `,
    width: 78,
    opaqueRows: true,
    render: ({ width = 76, height = 20 } = {}) => {
      const theme = themes[controller.state.settings?.theme] ?? themes.ocean;
      const innerWidth = Math.max(24, width - 4);
      const wrapped = source.flatMap((line) => line ? wrapText(line, innerWidth) : ['']);
      const bodyHeight = Math.max(3, Math.min(height - 2, Math.max(3, wrapped.length)));
      view.maxScroll = Math.max(0, wrapped.length - bodyHeight);
      view.scroll = Math.max(0, Math.min(view.scroll, view.maxScroll));
      return Box({
        border: true,
        borderColor: theme?.borderActive ?? theme?.accent ?? theme?.border,
        padding: { left: 1, right: 1 },
        title: ` ${localizedTitle} `,
        height: bodyHeight + 2,
      }, ScrollPane({
        lines: wrapped.map((line) => color(theme, 'text', line)),
        width: innerWidth,
        height: bodyHeight,
        scroll: view.scroll,
        border: false,
        footer: false,
        theme,
        pointerId: 'zipflow:help-overlay',
        onWheel: (event) => {
          view.scroll = Math.max(0, Math.min(view.maxScroll, view.scroll + wheelScrollDelta(event)));
          controller.invalidate();
          event.preventDefault();
          event.stopPropagation?.();
        },
      }));
    },
    onKey: ({ key }) => {
      const name = key?.name;
      if (['up', 'down', 'page-up', 'page-down', 'pageup', 'pagedown', 'home', 'end'].includes(name)) {
        const amount = name === 'page-up' || name === 'pageup' ? -6
          : name === 'page-down' || name === 'pagedown' ? 6
            : name === 'up' ? -1 : name === 'down' ? 1 : 0;
        if (name === 'home') view.scroll = 0;
        else if (name === 'end') view.scroll = view.maxScroll;
        else view.scroll = Math.max(0, Math.min(view.maxScroll, view.scroll + amount));
        controller.invalidate();
      }
      return { type: 'handled' };
    },
  });
  controller.invalidate();
  return true;
}
