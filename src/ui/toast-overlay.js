import {
  BottomOverlay,
  Box,
  Column,
  PointerRegion,
  Text,
  color,
  createNode,
  visibleLength,
  wrapText,
} from 'terlio.js';

const MIN_TOAST_WIDTH = 28;
const MAX_TOAST_WIDTH = 90;
const MAX_VISIBLE_TOASTS = 3;

export function overlayManagerWithoutToasts(manager) {
  if (!manager) return null;
  const proxy = Object.create(manager);
  proxy.toasts = [];
  return proxy;
}

export function renderZipflowToasts({ content, manager, theme, width, height, bottom = 2 } = {}) {
  const toasts = manager?.toasts?.slice(-MAX_VISIBLE_TOASTS) ?? [];
  if (!toasts.length) return content;
  const toastWidth = zipflowToastWidth(toasts, width);
  const nodes = toasts.map((toast) => PointerRegion({
    pointerId: `zipflow:toast:${toast.id ?? 'active'}`,
    pointerData: { kind: 'toast', id: toast.id ?? null },
    pointerWidth: 'fill',
    onClick: (event) => dismissToast(manager, toast, event),
    onRelease: (event) => dismissToast(manager, toast, event),
  }, ZipflowToast({ toast, theme, width: toastWidth })));
  return BottomOverlay({
    content,
    overlay: Column(...nodes),
    width: toastWidth,
    height,
    bottom,
    left: 2,
    right: 2,
    align: 'right',
    opaque: false,
  });
}

export function zipflowToastWidth(toasts, viewportWidth) {
  const available = Math.max(MIN_TOAST_WIDTH, Math.trunc(Number(viewportWidth) || 80) - 4);
  const maximum = Math.max(MIN_TOAST_WIDTH, Math.min(MAX_TOAST_WIDTH, available));
  let ideal = MIN_TOAST_WIDTH;
  for (const toast of toasts ?? []) {
    const values = [toast?.message, toast?.detail].map((value) => String(value ?? '').trim()).filter(Boolean);
    for (const value of values) {
      const longestWord = value.split(/\s+/u).reduce((size, word) => Math.max(size, visibleLength(word)), 0);
      const longestLine = value.split(/\r?\n/u).reduce((size, line) => Math.max(size, visibleLength(line)), 0);
      ideal = Math.max(ideal, longestWord + 10, Math.min(longestLine + 10, MAX_TOAST_WIDTH));
    }
  }
  return Math.min(maximum, ideal);
}

function ZipflowToast({ toast, theme, width }) {
  const level = normalizeLevel(toast?.level);
  const icon = { info: 'i', success: '✓', warning: '!', error: '×' }[level];
  const token = { info: 'accent', success: 'success', warning: 'warning', error: 'danger' }[level];
  const textWidth = Math.max(10, width - 8);
  const headline = wrappedLines(toast?.message, textWidth);
  const detail = wrappedLines(toast?.detail, textWidth);
  const lines = [
    ...headline.map((line, index) => Text(color(theme, token, `${index === 0 ? `${icon}  ` : '   '}${line}`), { wrap: false })),
    ...detail.map((line) => Text(color(theme, 'text', `   ${line}`), { wrap: false })),
  ];
  const body = Box({
    border: true,
    borderColor: theme?.[token] ?? theme?.accent ?? theme?.borderActive ?? theme?.border,
    padding: { left: 1, right: 1 },
  }, ...(lines.length ? lines : [Text(` ${icon}`)]));
  return createNode('shadowOverlay', {
    width,
    childWidth: Math.max(20, width - 2),
    inset: 0,
    offsetX: 1,
    offsetY: 1,
    shadowColor: theme?.borderMuted ?? theme?.border,
  }, [body]);
}

function wrappedLines(value, width) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  return text.split(/\r?\n/u).flatMap((line) => wrapText(line, width));
}

function normalizeLevel(value) {
  if (value === 'error' || value === 'warning' || value === 'success') return value;
  return 'info';
}

function dismissToast(manager, toast, event) {
  if (typeof toast?.onDismiss === 'function') toast.onDismiss(toast);
  else if (typeof manager?.dismissToast === 'function') manager.dismissToast(toast?.id);
  else if (Array.isArray(manager?.toasts)) manager.toasts = manager.toasts.filter((item) => item !== toast && item?.id !== toast?.id);
  event?.preventDefault?.();
  event?.stopPropagation?.();
  return true;
}
