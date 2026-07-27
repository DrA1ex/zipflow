import { parseKey } from 'terlio.js';

const SHIFT_ARROW_ALIASES = new Map([
  ['shift-up', 'up'],
  ['shift+up', 'up'],
  ['shift-arrow-up', 'up'],
  ['shift-arrowup', 'up'],
  ['shift-down', 'down'],
  ['shift+down', 'down'],
  ['shift-arrow-down', 'down'],
  ['shift-arrowdown', 'down'],
]);

export function normalizeZipflowKey(input = {}) {
  const key = input && typeof input === 'object' ? input : {};
  let normalized = key.printable && key.text === ' '
    ? { ...key, name: 'space' }
    : { ...key };

  const alias = SHIFT_ARROW_ALIASES.get(String(normalized.name ?? '').toLowerCase());
  if (alias) normalized = { ...normalized, name: alias, shift: true };

  if (hasShiftModifier(normalized) && normalized.shift !== true) {
    normalized = { ...normalized, shift: true };
  }

  if (!normalized.shift && isArrowName(normalized.name) && normalized.sequence) {
    const reparsed = safelyParseSequence(normalized.sequence);
    if (reparsed?.shift && reparsed.name === normalized.name) {
      normalized = {
        ...normalized,
        shift: true,
        ctrl: Boolean(normalized.ctrl || reparsed.ctrl),
        meta: Boolean(normalized.meta || reparsed.meta),
        cmd: Boolean(normalized.cmd || reparsed.cmd),
      };
    }
  }

  return normalized;
}

export function shiftArrowDirection(key) {
  const normalized = normalizeZipflowKey(key);
  if (!normalized.shift || !isArrowName(normalized.name)) return 0;
  return normalized.name === 'up' ? -1 : 1;
}

export function checkReorderDirection(key) {
  const arrowDirection = shiftArrowDirection(key);
  if (arrowDirection) return arrowDirection;

  // Some terminal emulators, notably the default macOS Terminal profile, do
  // not preserve Shift as a distinct modifier for arrow keys. Uppercase K/J
  // are ordinary printable bytes, so they provide a reliable Shift-based
  // fallback without changing plain list navigation.
  const normalized = normalizeZipflowKey(key);
  if (!normalized.printable) return 0;
  if (normalized.text === 'K' || normalized.name === 'K') return -1;
  if (normalized.text === 'J' || normalized.name === 'J') return 1;
  return 0;
}

function hasShiftModifier(key) {
  const modifiers = key?.modifiers;
  if (Array.isArray(modifiers)) return modifiers.some((value) => String(value).toLowerCase() === 'shift');
  if (modifiers && typeof modifiers === 'object') return Boolean(modifiers.shift);
  return false;
}

function isArrowName(name) {
  return name === 'up' || name === 'down';
}

function safelyParseSequence(sequence) {
  try {
    return parseKey(sequence);
  } catch {
    return null;
  }
}
