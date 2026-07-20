const DEFAULT_CONTEXT = 3;

export function renderDiffDocument(diff, mode, width, { context = DEFAULT_CONTEXT } = {}) {
  if (diff.binary) return { lines: [diff.message], hunkOffsets: [0], hunkCount: 1 };
  const ranges = changedRanges(diff.rows, context);
  if (!ranges.length) return { lines: ['No textual differences.'], hunkOffsets: [0], hunkCount: 1 };
  const lines = [];
  const hunkOffsets = [];
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (index > 0) lines.push(mode === 'side-by-side'
      ? { type: 'separator', left: '    …', right: '    …' }
      : { type: 'separator', text: '… unchanged lines omitted …' });
    hunkOffsets.push(lines.length);
    const rows = diff.rows.slice(range.start, range.end + 1);
    const meta = hunkMeta(rows);
    if (mode === 'side-by-side') {
      const columnWidth = Math.max(16, Math.floor((width - 7) / 2));
      lines.push({
        type: 'hunk',
        left: fit(`@@ -${meta.oldStart},${meta.oldCount}`, columnWidth),
        right: fit(`+${meta.newStart},${meta.newCount} @@`, columnWidth),
      });
      lines.push(...sideRows(rows, columnWidth));
    } else {
      lines.push({ type: 'hunk', text: `@@ -${meta.oldStart},${meta.oldCount} +${meta.newStart},${meta.newCount} @@` });
      lines.push(...rows.map(unifiedRow));
    }
  }
  return { lines, hunkOffsets, hunkCount: ranges.length };
}

export function changedRanges(rows, context = DEFAULT_CONTEXT) {
  const changed = [];
  for (let index = 0; index < rows.length; index += 1) if (rows[index].type !== 'same') changed.push(index);
  if (!changed.length) return [];
  const ranges = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length - 1, index + context);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

function unifiedRow(row) {
  if (row.type === 'same') return { type: 'same', text: ` ${row.oldText}` };
  if (row.type === 'remove') return { type: 'remove', text: `-${row.oldText}` };
  return { type: 'add', text: `+${row.newText}` };
}

function sideRows(rows, columnWidth) {
  const paired = pairRows(rows);
  return paired.map((row) => ({
    type: row.type,
    left: formatSide(row.oldNo, row.oldText, columnWidth),
    right: formatSide(row.newNo, row.newText, columnWidth),
  }));
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

function hunkMeta(rows) {
  const oldNumbers = rows.map((row) => row.oldNo).filter(Number.isFinite);
  const newNumbers = rows.map((row) => row.newNo).filter(Number.isFinite);
  return {
    oldStart: oldNumbers[0] ?? 0,
    oldCount: oldNumbers.length,
    newStart: newNumbers[0] ?? 0,
    newCount: newNumbers.length,
  };
}

function formatSide(lineNumber, text, width) {
  const prefix = lineNumber == null ? '    ' : String(lineNumber).padStart(4);
  const available = Math.max(4, width - prefix.length - 1);
  const compact = text.length > available ? `${text.slice(0, Math.max(1, available - 1))}…` : text;
  return `${prefix} ${compact.padEnd(available)}`;
}

function fit(value, width) {
  if (value.length >= width) return `${value.slice(0, Math.max(1, width - 1))}…`;
  return value.padEnd(width);
}
