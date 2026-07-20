import path from 'node:path';
import { stat } from 'node:fs/promises';
import { copyTextToClipboard } from 'terlio.js';
import { collectExportPaths, listExportTopLevel } from '../export/candidates.js';
import { inspectPotentiallySensitivePaths, sensitivePathMap } from '../export/sensitive.js';
import { createProjectArchive } from '../export/create.js';
import { displayPath, parseEnteredPath } from '../utils/paths.js';
import { runProcess } from '../utils/process.js';
import { rememberExportPath } from '../settings/recent.js';

export function handlesExportScreen(screen) {
  return ['export-mode', 'export-select', 'export-sensitive', 'export-preview', 'export-files', 'export-path', 'export-running', 'export-complete'].includes(screen);
}

export function beginCreateZip(controller) {
  controller.state.exportDraft = {
    mode: null,
    topLevel: [],
    selectedRoots: new Set(),
    selectedPaths: new Set(),
    pathSizes: new Map(),
    outputPath: defaultArchivePath(controller.state.project, controller.state.settings),
    sensitive: [],
    sensitiveAcknowledged: false,
  };
  showExportMode(controller);
}

export async function activateExport(controller, itemId) {
  const { state } = controller;
  if (state.screen === 'export-mode') {
    if (itemId === 'export-cancel') return controller.showHome();
    const mode = itemId.replace('export-', '');
    if (!['tracked', 'nonignored', 'interactive', 'all'].includes(mode)) return;
    state.exportDraft.mode = mode;
    if (mode === 'interactive') return prepareInteractiveSelection(controller);
    return prepareExportPreview(controller);
  }
  if (state.screen === 'export-select') {
    if (itemId.startsWith('export-item:')) return toggleExportItem(controller, itemId.slice(12));
    if (itemId === 'export-select-all') return selectAll(controller, true);
    if (itemId === 'export-select-none') return selectAll(controller, false);
    if (itemId === 'export-select-continue') return prepareExportPreview(controller);
    if (itemId === 'export-cancel') return controller.showHome();
  }
  if (state.screen === 'export-sensitive') {
    if (itemId === 'export-sensitive-exclude') {
      for (const record of state.exportDraft.sensitive) state.exportDraft.selectedPaths.delete(record.path);
      state.exportDraft.sensitiveAcknowledged = true;
      updateSelectedSize(state.exportDraft);
      controller.toast(`${state.exportDraft.sensitive.length} potentially sensitive files excluded`, 'success');
      return showExportPreview(controller);
    }
    if (itemId === 'export-sensitive-review') return showExportFiles(controller, null, { sensitiveOnly: true });
    if (itemId === 'export-sensitive-include') {
      state.exportDraft.sensitiveAcknowledged = true;
      return showExportPreview(controller);
    }
    if (itemId === 'export-cancel') return controller.showHome();
  }
  if (state.screen === 'export-preview') {
    if (itemId === 'export-choose-path') return proceedToExportPath(controller);
    if (itemId === 'export-review-files') return showExportFiles(controller);
    if (itemId === 'export-change-mode') return showExportMode(controller);
    if (itemId === 'export-cancel') return controller.showHome();
  }
  if (state.screen === 'export-files') {
    if (itemId.startsWith('export-file:')) return toggleReviewFile(controller, decodeURIComponent(itemId.slice(12)), state.selectedIndex);
    if (itemId.startsWith('export-dir:')) return toggleReviewDirectory(controller, decodeURIComponent(itemId.slice(11)), state.selectedIndex);
    if (itemId === 'export-files-all') return selectAllReviewFiles(controller, true);
    if (itemId === 'export-files-none') return selectAllReviewFiles(controller, false);
    if (itemId === 'export-files-back') return showExportPreview(controller);
    if (itemId === 'export-choose-path') return proceedToExportPath(controller);
  }
  if (state.screen === 'export-complete') {
    if (itemId === 'export-copy-path') {
      const copied = await copyTextToClipboard(state.exportDraft.result.outputPath, { output: controller.runtime?.output });
      return copied ? controller.toast('ZIP path copied', 'success') : controller.setStatus('Clipboard transfer unavailable');
    }
    if (itemId === 'export-open-folder') return openArchiveLocation(controller);
    if (itemId === 'export-again') return beginCreateZip(controller);
    if (itemId === 'export-home') return controller.showHome();
  }
}

export function handleExportShortcut(controller, key) {
  const { state } = controller;
  const selected = state.menuItems[state.selectedIndex];
  if (state.screen === 'export-select' && key.name === 'space' && selected?.id.startsWith('export-item:')) {
    toggleExportItem(controller, selected.id.slice(12), state.selectedIndex);
    return true;
  }
  if (state.screen === 'export-files' && key.name === 'space') {
    if (selected?.id.startsWith('export-file:')) toggleReviewFile(controller, decodeURIComponent(selected.id.slice(12)), state.selectedIndex);
    else if (selected?.id.startsWith('export-dir:')) toggleReviewDirectory(controller, decodeURIComponent(selected.id.slice(11)), state.selectedIndex);
    else return false;
    return true;
  }
  return false;
}

export async function submitExportEditor(controller) {
  if (controller.state.editorContext?.purpose !== 'export-path') return false;
  const entered = controller.state.editor.value.trim();
  if (!entered) {
    controller.setStatus('Enter the output ZIP path.');
    return true;
  }
  controller.state.exportDraft.outputPath = parseEnteredPath(entered, path.dirname(controller.state.project.root));
  await createArchive(controller);
  return true;
}

export function backExport(controller) {
  const screen = controller.state.screen;
  if (screen === 'export-mode') return controller.showHome();
  if (screen === 'export-select') return showExportMode(controller);
  if (screen === 'export-sensitive') return controller.state.exportDraft.mode === 'interactive' ? showInteractiveSelection(controller) : showExportMode(controller);
  if (screen === 'export-preview') return controller.state.exportDraft.mode === 'interactive' ? showInteractiveSelection(controller) : showExportMode(controller);
  if (screen === 'export-files') return showExportPreview(controller);
  if (screen === 'export-path') return showExportPreview(controller);
  if (screen === 'export-complete') return controller.showHome();
}

function showExportMode(controller) {
  const git = controller.state.project.git;
  controller.showMenu('export-mode', [
    {
      id: 'export-tracked',
      label: 'Git-tracked files',
      description: git ? 'Create the smallest reproducible archive from files already tracked by Git.' : 'Initialize Git first to use this mode.',
      disabled: !git,
    },
    { id: 'export-nonignored', label: 'Non-ignored files', description: 'Include tracked and untracked files, but leave out paths matched by .gitignore.' },
    { id: 'export-interactive', label: 'Choose top-level items', description: 'Select project folders and files from a compact top-level list.' },
    { id: 'export-all', label: 'Everything, including ignored files · advanced', description: 'Include ignored files too. A safety review checks likely secrets, private data, caches, and very large files. .git/ and .zipflow/ remain protected.' },
    { id: 'export-cancel', label: 'Cancel' },
  ], 'Create ZIP archive');
}

async function prepareInteractiveSelection(controller) {
  const entries = await listExportTopLevel(controller.state.project.root);
  controller.state.exportDraft.topLevel = entries;
  controller.state.exportDraft.selectedRoots = new Set(entries.map((entry) => entry.name));
  showInteractiveSelection(controller);
}

function showInteractiveSelection(controller, selectedIndex = null) {
  const draft = controller.state.exportDraft;
  const items = draft.topLevel.map((entry) => ({
    id: `export-item:${entry.name}`,
    label: `${draft.selectedRoots.has(entry.name) ? '[x]' : '[ ]'} ${entry.name}${entry.kind === 'directory' ? '/' : ''}`,
    description: entry.kind === 'directory' ? 'Include this folder recursively' : 'Include this file',
  }));
  items.push(
    { id: 'export-select-all', label: 'Select all' },
    { id: 'export-select-none', label: 'Clear selection' },
    { id: 'export-select-continue', label: 'Continue', description: `${draft.selectedRoots.size} top-level items selected`, disabled: draft.selectedRoots.size === 0 },
    { id: 'export-cancel', label: 'Cancel' },
  );
  controller.showMenu('export-select', items, 'Choose archive contents', selectedIndex);
}

function toggleExportItem(controller, name, selectedIndex = null) {
  const selected = controller.state.exportDraft.selectedRoots;
  if (selected.has(name)) selected.delete(name);
  else selected.add(name);
  showInteractiveSelection(controller, selectedIndex);
}

function selectAll(controller, enabled) {
  const draft = controller.state.exportDraft;
  draft.selectedRoots = new Set(enabled ? draft.topLevel.map((entry) => entry.name) : []);
  showInteractiveSelection(controller);
}

async function prepareExportPreview(controller) {
  const { state } = controller;
  const abortController = new AbortController();
  state.exportAbortController = abortController;
  state.busy = true;
  state.screen = 'export-running';
  state.busyLabel = 'Preparing ZIP preview';
  state.progress = { value: 0, total: 1, detail: 'Scanning project files' };
  controller.invalidate();
  try {
    const paths = await collectExportPaths({
      project: state.project,
      mode: state.exportDraft.mode,
      selectedRoots: [...state.exportDraft.selectedRoots],
      signal: abortController.signal,
      onProgress: ({ current = 0, total = 0, detail = '' }) => {
        state.progress = { value: current, total: Math.max(1, total || current + 1), detail: `Scanning · ${detail}` };
        controller.invalidate();
      },
    });
    const sortedPaths = paths.sort((left, right) => left.localeCompare(right));
    const pathSizes = await collectPathSizes(state.project.root, sortedPaths, {
      signal: abortController.signal,
      onProgress: (current, total, relative) => {
        state.progress = { value: current, total: Math.max(1, total), detail: `Reading sizes · ${relative}` };
        controller.invalidate();
      },
    });
    state.progress = { value: sortedPaths.length, total: Math.max(1, sortedPaths.length), detail: 'Checking sensitive and generated files' };
    state.exportDraft.paths = sortedPaths;
    state.exportDraft.selectedPaths = new Set(sortedPaths);
    state.exportDraft.pathSizes = pathSizes;
    state.exportDraft.sensitive = inspectPotentiallySensitivePaths(sortedPaths, { pathSizes });
    state.exportDraft.sensitiveMap = sensitivePathMap(state.exportDraft.sensitive);
    state.exportDraft.sensitiveAcknowledged = state.exportDraft.sensitive.length === 0;
    updateSelectedSize(state.exportDraft);
    state.busy = false;
    state.exportAbortController = null;
    if (state.exportDraft.sensitive.length) return showSensitiveReview(controller);
    return showExportPreview(controller);
  } catch (error) {
    state.busy = false;
    state.exportAbortController = null;
    if (error.code === 'cancelled') {
      controller.toast('ZIP preview preparation cancelled', 'info');
      return state.exportDraft.mode === 'interactive' ? showInteractiveSelection(controller) : showExportMode(controller);
    }
    controller.message('Could not prepare ZIP preview', [error.message], 'error', { collapsedSummary: `ZIP preview failed · ${error.message}` });
    return showExportMode(controller);
  }
}

async function collectPathSizes(root, paths, { signal, onProgress, concurrency = 16 } = {}) {
  const result = new Map();
  let next = 0;
  let completed = 0;
  async function worker() {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' });
      const index = next++;
      if (index >= paths.length) return;
      const relative = paths[index];
      result.set(relative, (await stat(path.join(root, relative))).size);
      completed += 1;
      onProgress?.(completed, paths.length, relative);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, paths.length)) }, () => worker()));
  return result;
}

function showSensitiveReview(controller) {
  const draft = controller.state.exportDraft;
  const counts = draft.sensitive.reduce((map, item) => map.set(item.category, (map.get(item.category) ?? 0) + 1), new Map());
  controller.showMenu('export-sensitive', [
    { id: 'export-sensitive-exclude', label: 'Exclude recommended files and continue', description: `Remove ${draft.sensitive.length} flagged files from this ZIP` },
    { id: 'export-sensitive-review', label: 'Review flagged files', description: 'Inspect reasons and include or exclude individual files' },
    { id: 'export-sensitive-include', label: 'Include anyway', description: 'Advanced: keep all flagged files in the archive' },
    { id: 'export-cancel', label: 'Cancel' },
  ], 'Potentially sensitive files found', 0, [
    `${draft.sensitive.length} flagged files · ${[...counts].map(([kind, count]) => `${count} ${kind}`).join(' · ')}`,
    'This is a conservative filename and path check, not a guarantee that every secret was found.',
  ]);
}

function hasUnacknowledgedSensitiveSelection(draft) {
  return !draft.sensitiveAcknowledged && draft.sensitive.some((record) => draft.selectedPaths.has(record.path));
}

function proceedToExportPath(controller) {
  if (hasUnacknowledgedSensitiveSelection(controller.state.exportDraft)) return showSensitiveReview(controller);
  return showExportPath(controller);
}

function showExportPreview(controller) {
  const draft = controller.state.exportDraft;
  controller.showMenu('export-preview', [
    { id: 'export-choose-path', label: 'Choose output path and create ZIP', description: draft.outputPath },
    { id: 'export-review-files', label: 'Review included files', description: `${draft.selectedPaths.size} of ${draft.paths.length} files selected` },
    { id: 'export-change-mode', label: 'Change export mode', description: modeLabel(draft.mode) },
    { id: 'export-cancel', label: 'Cancel' },
  ], 'Review ZIP contents', 0, [
    `${draft.selectedPaths.size} of ${draft.paths.length} files · ${formatBytes(draft.totalSize)}`,
    `Mode: ${modeLabel(draft.mode)}`,
    ...(draft.sensitive.length ? [`Safety review: ${draft.sensitive.filter((item) => draft.selectedPaths.has(item.path)).length} flagged files remain included.`] : []),
    '.git/ and .zipflow/ remain protected in every export mode.',
  ]);
}

function showExportFiles(controller, selectedIndex = null, { sensitiveOnly = false } = {}) {
  const draft = controller.state.exportDraft;
  const items = buildReviewItems(draft, { sensitiveOnly });
  items.push(
    { id: 'export-files-all', label: 'Include all files' },
    { id: 'export-files-none', label: 'Exclude all files' },
    { id: 'export-files-back', label: 'Back to ZIP preview', description: `${draft.selectedPaths.size} files selected` },
    { id: 'export-choose-path', label: 'Choose output path and create ZIP', disabled: draft.selectedPaths.size === 0 },
  );
  controller.showMenu('export-files', items, sensitiveOnly ? 'Review flagged files' : 'Choose included files', selectedIndex, [
    `${draft.selectedPaths.size} of ${draft.paths.length} files · ${formatBytes(draft.totalSize)}`,
    sensitiveOnly ? 'Only flagged files are shown. Enter or Space toggles each file.' : 'Root files appear first. Directories follow alphabetically; Enter or Space toggles a file or an entire directory.',
  ]);
}

function buildReviewItems(draft, { sensitiveOnly = false } = {}) {
  if (sensitiveOnly) return draft.sensitive.map((record) => reviewFileItem(draft, record.path, false));
  const rootFiles = draft.paths.filter((value) => !value.includes('/'));
  const directories = [...new Set(draft.paths.filter((value) => value.includes('/')).map((value) => value.split('/')[0]))]
    .sort((left, right) => left.localeCompare(right));
  const items = rootFiles.map((filePath) => reviewFileItem(draft, filePath, false));
  for (const directory of directories) {
    const children = draft.paths.filter((value) => value.startsWith(`${directory}/`));
    const selectedCount = children.filter((value) => draft.selectedPaths.has(value)).length;
    const marker = selectedCount === children.length ? '[x]' : selectedCount ? '[-]' : '[ ]';
    items.push({
      id: `export-dir:${encodeURIComponent(directory)}`,
      label: dimIfExcluded(`${marker} ${directory}/`, selectedCount === 0),
      description: selectedCount ? `${selectedCount} of ${children.length} files included · Enter toggles the folder` : `Excluded · ${children.length} files hidden`,
    });
    if (selectedCount) {
      for (const filePath of children) items.push(reviewFileItem(draft, filePath, true));
    }
  }
  return items;
}

function reviewFileItem(draft, filePath, nested) {
  const selected = draft.selectedPaths.has(filePath);
  const label = `${selected ? '[x]' : '[ ]'} ${nested ? '  ' : ''}${filePath}`;
  return {
    id: `export-file:${encodeURIComponent(filePath)}`,
    label: dimIfExcluded(label, !selected),
    description: draft.sensitiveMap?.get(filePath)?.reason ?? (selected ? 'Included in ZIP' : 'Excluded from ZIP · Enter to include'),
  };
}

function toggleReviewFile(controller, filePath, selectedIndex = null) {
  const selected = controller.state.exportDraft.selectedPaths;
  if (selected.has(filePath)) selected.delete(filePath);
  else {
    selected.add(filePath);
    if (controller.state.exportDraft.sensitiveMap?.has(filePath)) controller.state.exportDraft.sensitiveAcknowledged = false;
  }
  updateSelectedSize(controller.state.exportDraft);
  showExportFiles(controller, selectedIndex);
}

function toggleReviewDirectory(controller, directory, selectedIndex = null) {
  const draft = controller.state.exportDraft;
  const children = draft.paths.filter((value) => value.startsWith(`${directory}/`));
  const allSelected = children.every((value) => draft.selectedPaths.has(value));
  for (const filePath of children) {
    if (allSelected) draft.selectedPaths.delete(filePath);
    else draft.selectedPaths.add(filePath);
  }
  if (!allSelected && children.some((filePath) => draft.sensitiveMap?.has(filePath))) draft.sensitiveAcknowledged = false;
  updateSelectedSize(draft);
  showExportFiles(controller, selectedIndex);
}

function selectAllReviewFiles(controller, enabled) {
  const draft = controller.state.exportDraft;
  draft.selectedPaths = new Set(enabled ? draft.paths : []);
  if (enabled && draft.sensitive.length) draft.sensitiveAcknowledged = false;
  updateSelectedSize(draft);
  showExportFiles(controller);
}

function updateSelectedSize(draft) {
  draft.totalSize = [...draft.selectedPaths].reduce((total, filePath) => total + (draft.pathSizes.get(filePath) ?? 0), 0);
}

function dimIfExcluded(value, excluded) {
  return excluded ? `\u001b[2m${value}\u001b[22m` : value;
}

async function openArchiveLocation(controller) {
  const target = controller.state.exportDraft.result.outputPath;
  try {
    if (process.platform === 'darwin') await runProcess('open', ['-R', target]);
    else if (process.platform === 'linux') await runProcess('xdg-open', [path.dirname(target)]);
    else return controller.setStatus('Opening the containing folder is not supported on this platform.');
    controller.toast('Opened archive location', 'success');
  } catch (error) {
    controller.message('Could not open archive location', [error.message], 'warning');
  }
}

function showExportPath(controller) {
  const draft = controller.state.exportDraft;
  controller.showEditor('export-path', {
    label: 'Output ZIP path',
    placeholder: draft.outputPath,
    purpose: 'export-path',
    instructions: [
      `Mode: ${modeLabel(draft.mode)}`,
      'The archive is written outside the project by default so it cannot include itself.',
    ],
  }, draft.outputPath);
}

async function createArchive(controller) {
  const { state } = controller;
  state.busy = true;
  state.screen = 'export-running';
  state.busyLabel = 'Creating ZIP archive';
  state.progress = { value: 0, total: 1, detail: 'Collecting files' };
  controller.invalidate();
  try {
    const paths = state.exportDraft.selectedPaths instanceof Set ? [...state.exportDraft.selectedPaths] : state.exportDraft.paths ?? await collectExportPaths({
      project: state.project,
      mode: state.exportDraft.mode,
      selectedRoots: [...state.exportDraft.selectedRoots],
    });
    state.progress = { value: 0, total: Math.max(1, paths.length), detail: `${paths.length} files selected` };
    const result = await createProjectArchive({
      projectRoot: state.project.root,
      paths,
      outputPath: state.exportDraft.outputPath,
      onProgress: ({ current, total, path: currentPath }) => {
        state.progress = { value: current, total: Math.max(1, total), detail: currentPath };
        controller.invalidate();
      },
    });
    state.exportDraft.result = result;
    state.settings = await rememberExportPath(state, result.outputPath);
    state.busy = false;
    controller.message('ZIP archive created', [
      displayPath(result.outputPath),
      `${result.fileCount} files · ${formatBytes(result.size)}`,
      `Mode: ${modeLabel(state.exportDraft.mode)}`,
    ], 'success');
    controller.showMenu('export-complete', [
      { id: 'export-copy-path', label: 'Copy ZIP path', description: displayPath(result.outputPath) },
      { id: 'export-open-folder', label: 'Open containing folder', description: 'Reveal the created archive in the system file manager' },
      { id: 'export-home', label: 'Return to project' },
      { id: 'export-again', label: 'Create another ZIP' },
    ], 'Archive ready', 0, [
      `${result.fileCount} files · ${formatBytes(result.size)}`,
      `Mode: ${modeLabel(state.exportDraft.mode)}`,
      displayPath(result.outputPath),
    ]);
  } catch (error) {
    state.busy = false;
    controller.message('Could not create ZIP archive', [error.message], 'error');
    showExportMode(controller);
  }
}

function defaultArchivePath(project, settings = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
  const directory = settings.lastExportDirectory || path.dirname(project.root);
  return path.join(directory, `${safeName(project.name)}-${stamp}.zip`);
}

function safeName(value) {
  return String(value || 'project').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function modeLabel(mode) {
  if (mode === 'tracked') return 'Git-tracked files';
  if (mode === 'nonignored') return 'Non-ignored files';
  if (mode === 'interactive') return 'Selected top-level items';
  return 'Everything, including ignored files';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
