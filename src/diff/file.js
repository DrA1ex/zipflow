import { readFile } from 'node:fs/promises';

const MAX_DIFF_BYTES = 768 * 1024;
const MAX_LCS_CELLS = 160_000;

export async function loadPlanItemDiff(item) {
  const before = item.kind === 'created' ? Buffer.alloc(0) : await readFile(item.currentPath);
  const after = item.kind === 'deleted' ? Buffer.alloc(0) : await readFile(item.sourcePath);
  if (before.length > MAX_DIFF_BYTES || after.length > MAX_DIFF_BYTES || isBinary(before) || isBinary(after)) {
    return {
      path: item.path,
      kind: item.kind,
      binary: true,
      message: `Binary or large file · before ${formatBytes(before.length)} · after ${formatBytes(after.length)}`,
      rows: [],
    };
  }
  const oldLines = splitLines(before.toString('utf8'));
  const newLines = splitLines(after.toString('utf8'));
  return {
    path: item.path,
    kind: item.kind,
    binary: false,
    oldLines,
    newLines,
    rows: diffRows(oldLines, newLines),
  };
}

export function unifiedDiffLines(diff) {
  if (diff.binary) return [diff.message];
  const lines = [`--- ${diff.kind === 'created' ? '/dev/null' : `local/${diff.path}`}`, `+++ ${diff.kind === 'deleted' ? '/dev/null' : `archive/${diff.path}`}`];
  for (const row of diff.rows) {
    if (row.type === 'same') lines.push({ type: 'same', text: ` ${row.oldText}` });
    if (row.type === 'remove') lines.push({ type: 'remove', text: `-${row.oldText}` });
    if (row.type === 'add') lines.push({ type: 'add', text: `+${row.newText}` });
  }
  return lines;
}

export function sideBySideDiffLines(diff, width) {
  if (diff.binary) return [diff.message];
  const columnWidth = Math.max(16, Math.floor((width - 7) / 2));
  const paired = pairRows(diff.rows);
  return paired.map((row) => ({
    type: row.type,
    left: formatSide(row.oldNo, row.oldText, columnWidth),
    right: formatSide(row.newNo, row.newText, columnWidth),
  }));
}

function diffRows(oldLines, newLines) {
  if (oldLines.length * newLines.length <= MAX_LCS_CELLS) return lcsRows(oldLines, newLines);
  return fallbackRows(oldLines, newLines);
}

function lcsRows(oldLines, newLines) {
  const table = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  const rows = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({ type: 'same', oldNo: oldIndex + 1, newNo: newIndex + 1, oldText: oldLines[oldIndex], newText: newLines[newIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex < newLines.length && (oldIndex === oldLines.length || table[oldIndex][newIndex + 1] >= table[oldIndex + 1][newIndex])) {
      rows.push({ type: 'add', oldNo: null, newNo: newIndex + 1, oldText: '', newText: newLines[newIndex] });
      newIndex += 1;
    } else {
      rows.push({ type: 'remove', oldNo: oldIndex + 1, newNo: null, oldText: oldLines[oldIndex], newText: '' });
      oldIndex += 1;
    }
  }
  return rows;
}

function fallbackRows(oldLines, newLines) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix += 1;
  const rows = [];
  for (let index = 0; index < prefix; index += 1) rows.push(sameRow(oldLines[index], index, index));
  for (let index = prefix; index < oldLines.length - suffix; index += 1) {
    rows.push({ type: 'remove', oldNo: index + 1, newNo: null, oldText: oldLines[index], newText: '' });
  }
  for (let index = prefix; index < newLines.length - suffix; index += 1) {
    rows.push({ type: 'add', oldNo: null, newNo: index + 1, oldText: '', newText: newLines[index] });
  }
  for (let offset = suffix; offset > 0; offset -= 1) {
    const oldIndex = oldLines.length - offset;
    const newIndex = newLines.length - offset;
    rows.push(sameRow(oldLines[oldIndex], oldIndex, newIndex));
  }
  return rows;
}

function pairRows(rows) {
  const result = [];
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    const next = rows[index + 1];
    if (current.type === 'remove' && next?.type === 'add') {
      result.push({ type: 'change', oldNo: current.oldNo, oldText: current.oldText, newNo: next.newNo, newText: next.newText });
      index += 1;
    } else result.push(current);
  }
  return result;
}

function sameRow(text, oldIndex, newIndex) {
  return { type: 'same', oldNo: oldIndex + 1, newNo: newIndex + 1, oldText: text, newText: text };
}

function formatSide(lineNumber, text, width) {
  const prefix = lineNumber == null ? '    ' : String(lineNumber).padStart(4);
  const available = Math.max(4, width - prefix.length - 1);
  const compact = text.length > available ? `${text.slice(0, Math.max(1, available - 1))}…` : text;
  return `${prefix} ${compact.padEnd(available)}`;
}

function splitLines(value) {
  if (!value) return [];
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function isBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
