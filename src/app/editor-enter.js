export function isPlainEnter(key) {
  return key?.name === 'enter' && !key.ctrl && !key.shift && !key.meta && !key.cmd;
}

export function isEditorLineBreak(key, { multiline = false } = {}) {
  return Boolean(multiline) && key?.name === 'enter' && Boolean(key.shift || key.ctrl);
}

export function isModifiedEnter(key) {
  return key?.name === 'enter' && Boolean(key.shift || key.ctrl || key.meta || key.cmd);
}
