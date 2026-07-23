export function isSelectable(items, index) {
  return Number.isInteger(index)
    && index >= 0
    && index < items.length
    && !items[index]?.disabled
    && !items[index]?.blocked
    && !items[index]?.loading;
}

export function nearestSelectableIndex(items, preferredIndex, { preferDirection = 1 } = {}) {
  if (!Array.isArray(items) || !items.length) return null;
  const start = clampIndex(preferredIndex, items.length);
  if (isSelectable(items, start)) return start;

  const firstDirection = preferDirection < 0 ? -1 : 1;
  for (let distance = 1; distance < items.length; distance += 1) {
    const first = start + distance * firstDirection;
    if (isSelectable(items, first)) return first;
    const second = start - distance * firstDirection;
    if (isSelectable(items, second)) return second;
  }
  return null;
}

export function normalizeSelectableIndex(items, selectedIndex, options = {}) {
  const nearest = nearestSelectableIndex(items, selectedIndex, options);
  if (nearest !== null) return nearest;
  return Array.isArray(items) && items.length ? clampIndex(selectedIndex, items.length) : 0;
}

export function moveSelectableIndex(items, selectedIndex, delta, { wrap = true } = {}) {
  if (!Array.isArray(items) || !items.length) return 0;
  const amount = Math.trunc(Number(delta) || 0);
  const direction = Math.sign(amount);
  let current = normalizeSelectableIndex(items, selectedIndex, { preferDirection: direction || 1 });
  if (!direction) return current;

  if (items.every((item, index) => isSelectable(items, index))) {
    return wrap
      ? wrapIndex(current + amount, items.length)
      : clampIndex(current + amount, items.length);
  }

  for (let step = 0; step < Math.abs(amount); step += 1) {
    const next = nextSelectableIndex(items, current, direction, { wrap });
    if (next === null) break;
    current = next;
  }
  return current;
}

export function pageSelectableIndex(items, selectedIndex, direction, pageSize) {
  if (!Array.isArray(items) || !items.length) return 0;
  const step = Math.sign(Number(direction) || 0);
  const current = normalizeSelectableIndex(items, selectedIndex, { preferDirection: step || 1 });
  if (!step) return current;
  const amount = Math.max(1, Math.trunc(Number(pageSize) || 1));
  const target = clampIndex(current + step * amount, items.length);
  return nearestSelectableIndex(items, target, { preferDirection: step }) ?? current;
}

function nextSelectableIndex(items, currentIndex, direction, { wrap }) {
  const direct = currentIndex + direction;
  if (!wrap && (direct < 0 || direct >= items.length)) return null;

  let candidate = wrapIndex(direct, items.length);
  if (isSelectable(items, candidate)) return candidate;

  // Scanning is only needed when the direct target cannot be selected.
  for (let inspected = 1; inspected < items.length; inspected += 1) {
    candidate += direction;
    if (!wrap && (candidate < 0 || candidate >= items.length)) return null;
    candidate = wrapIndex(candidate, items.length);
    if (isSelectable(items, candidate)) return candidate;
  }
  return null;
}

function clampIndex(value, length) {
  const numeric = Number.isInteger(value) ? value : 0;
  return Math.max(0, Math.min(length - 1, numeric));
}

function wrapIndex(value, length) {
  return ((value % length) + length) % length;
}
