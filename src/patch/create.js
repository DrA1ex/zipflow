import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ensureDir, writeTextAtomic } from '../utils/fs.js';
import { getZipflowHome } from '../workflow/store.js';

const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

export async function createPlanPatch(runId, plan) {
  const sections = [];
  let omitted = 0;
  for (const item of [...plan.created, ...plan.updated, ...plan.deleted]) {
    const section = await itemPatch(item);
    if (Buffer.byteLength(sections.join('\n') + section, 'utf8') > MAX_PATCH_BYTES) {
      omitted += 1;
      continue;
    }
    sections.push(section);
  }
  if (omitted) sections.push(`# Zipflow omitted ${omitted} additional file patches because the patch exceeded ${MAX_PATCH_BYTES} bytes.\n`);
  const content = sections.join('\n');
  const target = path.join(getZipflowHome(), 'runs', runId, 'changes.patch');
  await ensureDir(path.dirname(target));
  await writeTextAtomic(target, content || '# No file content changes.\n');
  return { path: target, content: content || '# No file content changes.\n', omitted };
}

async function itemPatch(item) {
  const before = item.kind === 'created' ? Buffer.alloc(0) : await readFile(item.currentPath);
  const after = item.kind === 'deleted' ? Buffer.alloc(0) : await readFile(item.sourcePath);
  const header = [
    `diff --git a/${item.path} b/${item.path}`,
    ...(item.kind === 'created' ? ['new file mode 100644'] : []),
    ...(item.kind === 'deleted' ? ['deleted file mode 100644'] : []),
  ];
  if (isBinary(before) || isBinary(after) || before.length > MAX_TEXT_FILE_BYTES || after.length > MAX_TEXT_FILE_BYTES) {
    return `${header.join('\n')}\nBinary or large file changed: ${item.path}\n`;
  }
  const oldLines = splitLines(before.toString('utf8'));
  const newLines = splitLines(after.toString('utf8'));
  const oldLabel = item.kind === 'created' ? '/dev/null' : `a/${item.path}`;
  const newLabel = item.kind === 'deleted' ? '/dev/null' : `b/${item.path}`;
  return `${header.join('\n')}\n--- ${oldLabel}\n+++ ${newLabel}\n${singleHunk(oldLines, newLines)}`;
}

function singleHunk(oldLines, newLines) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  const context = 3;
  const oldStartIndex = Math.max(0, prefix - context);
  const newStartIndex = Math.max(0, prefix - context);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + context);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + context);
  const beforeContext = oldLines.slice(oldStartIndex, prefix);
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const afterContext = oldLines.slice(oldLines.length - suffix, oldEnd);
  const oldCount = beforeContext.length + removed.length + afterContext.length;
  const newCount = beforeContext.length + added.length + afterContext.length;
  const lines = [
    `@@ -${rangeStart(oldStartIndex, oldCount)},${oldCount} +${rangeStart(newStartIndex, newCount)},${newCount} @@`,
    ...beforeContext.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...afterContext.map((line) => ` ${line}`),
  ];
  return `${lines.join('\n')}\n`;
}

function rangeStart(index, count) {
  return count === 0 ? 0 : index + 1;
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
