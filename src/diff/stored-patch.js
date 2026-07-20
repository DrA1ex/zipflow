import { readFile } from 'node:fs/promises';
import { exists } from '../utils/fs.js';

const MAX_ACTIVITY_LINES = 6000;

export async function loadStoredPatch(run) {
  const target = run?.patch?.path;
  if (!target || !(await exists(target))) return null;
  const content = await readFile(target, 'utf8');
  return { path: target, content, sections: parsePatchSections(content) };
}

export async function loadStoredFileDiff(run, filePath) {
  const patch = await loadStoredPatch(run);
  const section = patch?.sections.find((item) => item.path === filePath);
  if (!section) return {
    path: filePath,
    kind: runFileKind(run, filePath),
    binary: true,
    message: 'The stored patch does not contain a textual diff for this file.',
    rows: [],
  };
  return sectionToDiff(section, runFileKind(run, filePath));
}

export async function storedPatchActivityLines(run) {
  const patch = await loadStoredPatch(run);
  if (!patch) return ['The stored changes.patch file is unavailable for this run.'];
  const lines = patch.content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= MAX_ACTIVITY_LINES) return lines;
  return [
    ...lines.slice(0, MAX_ACTIVITY_LINES),
    `… ${lines.length - MAX_ACTIVITY_LINES} additional lines omitted from Activity`,
    `Full patch: ${patch.path}`,
  ];
}

export function runChangedGroups(run) {
  const plan = run?.plan ?? {};
  return [
    { id: 'created', label: 'Added', paths: normalizePaths(plan.created) },
    { id: 'updated', label: 'Changed', paths: normalizePaths(plan.updated) },
    { id: 'deleted', label: 'Removed', paths: normalizePaths(plan.deleted) },
  ].filter((group) => group.paths.length);
}

export function parsePatchSections(content) {
  const lines = String(content ?? '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('diff --git a/')) {
      if (current) sections.push(current);
      current = { path: parseHeaderPath(line), lines: [line] };
    } else if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections.filter((section) => section.path);
}

function sectionToDiff(section, kind) {
  const binaryLine = section.lines.find((line) => line.startsWith('Binary or large file changed:'));
  if (binaryLine) return { path: section.path, kind, binary: true, message: binaryLine, rows: [] };
  const rows = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of section.lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\ No newline')) continue;
    if (line.startsWith('-')) {
      rows.push({ type: 'remove', oldNo, newNo: null, oldText: line.slice(1), newText: '' });
      oldNo += 1;
    } else if (line.startsWith('+')) {
      rows.push({ type: 'add', oldNo: null, newNo, oldText: '', newText: line.slice(1) });
      newNo += 1;
    } else if (line.startsWith(' ')) {
      const text = line.slice(1);
      rows.push({ type: 'same', oldNo, newNo, oldText: text, newText: text });
      oldNo += 1;
      newNo += 1;
    }
  }
  if (!rows.length) return {
    path: section.path,
    kind,
    binary: true,
    message: 'No textual hunk was stored for this file.',
    rows: [],
  };
  return { path: section.path, kind, binary: false, rows };
}

function parseHeaderPath(line) {
  const prefix = 'diff --git a/';
  const rest = line.slice(prefix.length);
  const marker = rest.lastIndexOf(' b/');
  return marker < 0 ? '' : rest.slice(0, marker);
}

function runFileKind(run, filePath) {
  if (normalizePaths(run?.plan?.created).includes(filePath)) return 'created';
  if (normalizePaths(run?.plan?.deleted).includes(filePath)) return 'deleted';
  return 'updated';
}

function normalizePaths(values = []) {
  return values.map((item) => typeof item === 'string' ? item : item?.path).filter(Boolean);
}
