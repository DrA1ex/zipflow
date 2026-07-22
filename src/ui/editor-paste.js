export function pastedTextFromKey(key) {
  if (!key || typeof key !== 'object') return null;
  const explicitPaste = key.name === 'paste' || key.id === 'paste' || key.type === 'paste' || key.event === 'paste'
    || key.paste === true || key.bracketedPaste === true || typeof key.paste === 'string';
  const value = firstTextValue(key.paste, key.text, key.value, key.data, key.content);
  if (explicitPaste) return value ?? '';
  if (key.printable && typeof key.text === 'string' && /[\r\n]/.test(key.text)) return key.text;
  return null;
}

export function insertPastedText(editor, pastedText, { multiline = false } = {}) {
  if (!editor || typeof editor.insert !== 'function') throw new TypeError('Paste target must be an InputEditor.');
  const normalized = String(pastedText ?? '').replace(/\r\n?/g, '\n');
  const value = multiline ? normalized : normalized.replace(/\n+/g, ' ');
  if (!value) return value;
  if (!multiline || !value.includes('\n')) {
    editor.insert(value);
    return value;
  }
  if (typeof editor.set !== 'function') throw new TypeError('Multiline paste target must support atomic replacement.');
  const current = String(editor.value ?? '');
  const cursor = Math.max(0, Math.min(current.length, Number(editor.cursor) || 0));
  editor.set(`${current.slice(0, cursor)}${value}${current.slice(cursor)}`);
  editor.cursor = cursor + value.length;
  return value;
}

function firstTextValue(...values) {
  for (const value of values) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      for (const key of ['text', 'value', 'data', 'content']) {
        if (typeof value[key] === 'string') return value[key];
      }
    }
  }
  return null;
}
