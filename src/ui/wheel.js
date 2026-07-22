export const WHEEL_SCROLL_ROWS = 3;

export function wheelScrollDelta(event, rows = WHEEL_SCROLL_ROWS) {
  const delta = Number(event?.deltaY) || 0;
  if (!delta) return 0;
  return Math.sign(delta) * Math.max(1, Math.trunc(Number(rows) || WHEEL_SCROLL_ROWS));
}
