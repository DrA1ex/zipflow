import path from 'node:path';

const FLAT_SENSITIVE_FILE_LIMIT = 5;

export function initializeExportTree(draft, { directory = '', origin = 'preview', sensitiveOnly = false } = {}) {
  draft.treeDirectory = normalizeDirectory(directory);
  draft.treeOrigin = origin;
  draft.treeSensitiveOnly = sensitiveOnly;
}

export function exportTreeItems(draft) {
  const directory = normalizeDirectory(draft.treeDirectory);
  const sourcePaths = filteredPaths(draft);
  const entries = draft.treeSensitiveOnly
    ? sensitiveEntries(sourcePaths, directory)
    : immediateEntries(sourcePaths, directory);
  return entries.map((entry) => treeItem(draft, entry));
}

export function toggleTreeEntry(draft, entryPath) {
  const descendants = descendantsFor(draft.paths, entryPath);
  const isDirectory = descendants.some((value) => value !== entryPath);
  const targets = isDirectory ? descendants : [entryPath];
  const allSelected = targets.length > 0 && targets.every((value) => draft.selectedPaths.has(value));
  for (const target of targets) {
    if (allSelected) draft.selectedPaths.delete(target);
    else draft.selectedPaths.add(target);
  }
  if (!allSelected && targets.some((value) => draft.sensitiveMap?.has(value))) draft.sensitiveAcknowledged = false;
}

export function enterTreeDirectory(draft, directory) {
  draft.treeDirectory = normalizeDirectory(directory);
}

export function leaveTreeDirectory(draft) {
  const current = normalizeDirectory(draft.treeDirectory);
  if (!current) return false;
  draft.treeDirectory = path.posix.dirname(current) === '.' ? '' : path.posix.dirname(current);
  return true;
}

export function selectAllTreePaths(draft, enabled) {
  const paths = filteredPaths(draft);
  for (const relative of paths) {
    if (enabled) draft.selectedPaths.add(relative);
    else draft.selectedPaths.delete(relative);
  }
  if (enabled && paths.some((value) => draft.sensitiveMap?.has(value))) draft.sensitiveAcknowledged = false;
}

export function nextDirectoryItemIndex(items, currentIndex, delta = 1) {
  const indexes = items.map((item, index) => item.kind === 'directory' ? index : -1).filter((index) => index >= 0);
  if (!indexes.length) return currentIndex;
  const currentPosition = indexes.findIndex((index) => index >= currentIndex);
  if (delta > 0) return indexes[(currentPosition >= 0 ? currentPosition + 1 : 0) % indexes.length];
  const base = currentPosition >= 0 ? currentPosition - 1 : indexes.length - 1;
  return indexes[(base + indexes.length) % indexes.length];
}

export function treeLocationLabel(draft) {
  return draft.treeDirectory ? `/${draft.treeDirectory}` : '/';
}

function treeItem(draft, entry) {
  const targets = entry.kind === 'directory' ? descendantsFor(draft.paths, entry.path) : [entry.path];
  const selectedCount = targets.filter((value) => draft.selectedPaths.has(value)).length;
  const marker = selectedCount === 0 ? '[ ]' : selectedCount === targets.length ? '[x]' : '[■]';
  const annotation = aggregateAnnotation(draft, targets);
  const description = entry.kind === 'directory'
    ? `${selectedCount} of ${targets.length} files selected${annotation ? ` · ${annotation}` : ''}`
    : annotation ?? (selectedCount ? 'Included in ZIP' : 'Excluded from ZIP');
  return {
    id: `export-tree-${entry.kind}:${encodeURIComponent(entry.path)}`,
    path: entry.path,
    kind: entry.kind,
    label: dimIfExcluded(`${marker} ${entry.name}${entry.kind === 'directory' ? '/ ›' : ''}`, selectedCount === 0),
    description,
    context: entry.kind === 'directory' ? `${description} · Enter opens this folder` : description,
    help: entry.kind === 'directory' ? `${description}. Press Enter to open this folder or Space to toggle the whole folder.` : `${description}. Press Space to include or exclude this file.`,
    navigate: entry.kind === 'directory',
  };
}

function filteredPaths(draft) {
  if (!draft.treeSensitiveOnly) return draft.paths ?? [];
  const sensitive = new Set((draft.sensitive ?? []).map((record) => record.path));
  return (draft.paths ?? []).filter((value) => sensitive.has(value));
}

function immediateEntries(paths, directory) {
  const prefix = directory ? `${directory}/` : '';
  const map = new Map();
  for (const relative of paths) {
    if (!relative.startsWith(prefix)) continue;
    const remainder = relative.slice(prefix.length);
    if (!remainder) continue;
    const [name, ...rest] = remainder.split('/');
    const entryPath = prefix ? `${directory}/${name}` : name;
    const kind = rest.length ? 'directory' : 'file';
    const current = map.get(entryPath);
    if (!current || kind === 'directory') map.set(entryPath, { path: entryPath, name, kind });
  }
  return [...map.values()].sort((left, right) => (
    left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1
  ));
}

function sensitiveEntries(paths, directory) {
  if (!directory && paths.length <= FLAT_SENSITIVE_FILE_LIMIT) {
    return [...paths].sort((left, right) => left.localeCompare(right)).map((relative) => ({
      path: relative,
      name: relative,
      kind: 'file',
    }));
  }
  const prefix = directory ? `${directory}/` : '';
  return immediateEntries(paths, directory).map((entry) => {
    if (entry.kind !== 'directory') return entry;
    const descendants = descendantsFor(paths, entry.path);
    if (descendants.length !== 1) return entry;
    const onlyPath = descendants[0];
    return {
      path: onlyPath,
      name: onlyPath.slice(prefix.length),
      kind: 'file',
    };
  }).sort(compareEntries);
}

function compareEntries(left, right) {
  return left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1;
}

function descendantsFor(paths, entryPath) {
  return paths.filter((value) => value === entryPath || value.startsWith(`${entryPath}/`));
}

function aggregateAnnotation(draft, targets) {
  const labels = [];
  for (const target of targets) {
    const annotation = draft.pathAnnotations?.get(target);
    const sensitive = draft.sensitiveMap?.get(target);
    if (sensitive?.reason) labels.push(sensitive.reason);
    else if (annotation?.reason) labels.push(annotation.reason);
  }
  const unique = [...new Set(labels)];
  if (!unique.length) return '';
  if (unique.length === 1) return unique[0];
  return `${unique.length} excluded or sensitive categories`;
}

function normalizeDirectory(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
}

function dimIfExcluded(value, excluded) {
  return excluded ? `\u001b[2m${value}\u001b[22m` : value;
}
