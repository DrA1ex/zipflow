import path from 'node:path';
import { stat } from 'node:fs/promises';
import { copyTextToClipboard } from 'terlio.js';
import { collectCustomExportPaths, collectExportPaths, classifyCustomExportPaths } from '../export/candidates.js';
import { inspectPotentiallySensitivePaths, sensitivePathMap } from '../export/sensitive.js';
import { createProjectArchive } from '../export/create.js';
import { displayPath } from '../utils/paths.js';
import { runProcess } from '../utils/process.js';
import { rememberExportPath } from '../settings/recent.js';
import { exists } from '../utils/fs.js';
import { defaultArchivePath, normalizeOutputArchivePath } from '../export/output-path.js';
import {
  enterTreeDirectory, exportTreeItems, initializeExportTree, leaveTreeDirectory,
  nextDirectoryItemIndex, selectAllTreePaths, toggleTreeEntry, treeLocationLabel,
} from './export-tree.js';

export function handlesExportScreen(screen) {
  return ['export-mode', 'export-sensitive', 'export-protected', 'export-preview', 'export-files', 'export-path', 'export-overwrite', 'export-running', 'export-complete'].includes(screen);
}

export function beginCreateZip(controller) {
  controller.state.exportDraft = {
    mode: null,
    paths: [],
    selectedPaths: new Set(),
    pathSizes: new Map(),
    pathAnnotations: new Map(),
    outputPath: defaultArchivePath(controller.state.project, controller.state.settings),
    sensitive: [],
    sensitiveMap: new Map(),
    sensitiveAcknowledged: false,
    protectedPending: null,
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
    return prepareExportPreview(controller, { custom: mode === 'interactive' });
  }
  if (state.screen === 'export-sensitive') return activateSensitiveReview(controller, itemId);
  if (state.screen === 'export-protected') return activateProtectedReview(controller, itemId);
  if (state.screen === 'export-preview') {
    if (itemId === 'export-choose-path') return proceedToExportPath(controller);
    if (itemId === 'export-review-files') return showExportFiles(controller, null, { origin: 'preview' });
    if (itemId === 'export-change-mode') return showExportMode(controller);
    if (itemId === 'export-cancel') return controller.showHome();
  }
  if (state.screen === 'export-files') return activateTreeItem(controller, itemId);
  if (state.screen === 'export-overwrite') {
    if (itemId === 'export-overwrite-confirm') {
      state.exportDraft.outputPath = state.exportDraft.pendingOutputPath;
      state.exportDraft.pendingOutputPath = null;
      return createArchive(controller);
    }
    if (itemId === 'export-overwrite-back') {
      state.exportDraft.pendingOutputPath = null;
      return showExportPath(controller);
    }
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
  if (state.screen !== 'export-files') return false;
  const selected = state.menuItems[state.selectedIndex];
  if (key.name === 'space' && selected?.path) {
    requestTreeToggle(controller, selected.path, state.selectedIndex);
    return true;
  }
  if (key.name === 'tab' && key.shift) {
    if (leaveTreeDirectory(state.exportDraft)) showExportFiles(controller, 0);
    return true;
  }
  if (key.name === 'tab') {
    state.selectedIndex = nextDirectoryItemIndex(state.menuItems, state.selectedIndex, 1);
    return true;
  }
  if (key.name === 'left' || key.name === 'backspace') {
    if (leaveTreeDirectory(state.exportDraft)) showExportFiles(controller, 0);
    return true;
  }
  return false;
}

export async function submitExportEditor(controller) {
  if (controller.state.editorContext?.purpose !== 'export-path') return false;
  const state = controller.state;
  const entered = state.editor.value.trim() || state.exportDraft.outputPath;
  const outputPath = await normalizeOutputArchivePath(entered, {
    cwd: path.dirname(state.project.root),
    project: state.project,
    settings: state.settings,
    currentDefault: state.exportDraft.outputPath,
  });
  if (await exists(outputPath)) {
    state.exportDraft.pendingOutputPath = outputPath;
    controller.showMenu('export-overwrite', [
      { id: 'export-overwrite-confirm', label: 'Replace existing archive', description: displayPath(outputPath) },
      { id: 'export-overwrite-back', label: 'Choose another path' },
    ], 'Archive already exists', 1, [`${displayPath(outputPath)} already exists.`]);
    return true;
  }
  state.exportDraft.outputPath = outputPath;
  await createArchive(controller);
  return true;
}

export function backExport(controller) {
  const { state } = controller;
  const screen = state.screen;
  if (screen === 'export-mode') return controller.showHome();
  if (screen === 'export-sensitive') return showExportPreview(controller);
  if (screen === 'export-protected') return showExportFiles(controller, state.exportDraft.treeReturnIndex ?? 0);
  if (screen === 'export-preview') return showExportMode(controller);
  if (screen === 'export-files') {
    if (leaveTreeDirectory(state.exportDraft)) return showExportFiles(controller, 0);
    if (state.exportDraft.treeOrigin === 'mode') return showExportMode(controller);
    if (state.exportDraft.treeOrigin === 'sensitive') return showSensitiveReview(controller);
    return showExportPreview(controller);
  }
  if (screen === 'export-path') return showExportPreview(controller);
  if (screen === 'export-overwrite') return showExportPath(controller);
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
    { id: 'export-nonignored', label: 'Non-ignored files', description: 'Include tracked and untracked files, except paths matched by project ignore rules.' },
    { id: 'export-interactive', label: 'Custom selection', description: 'Browse the project as a tree and choose individual folders or files.' },
    { id: 'export-all', label: 'Everything, including ignored files · advanced', description: 'Include ignored files too. A safety review identifies likely secrets, private data, generated directories, and very large files.' },
    { id: 'export-cancel', label: 'Cancel' },
  ], 'Create ZIP archive');
}

async function prepareExportPreview(controller, { custom = false } = {}) {
  const { state } = controller;
  const abortController = new AbortController();
  state.exportAbortController = abortController;
  state.busy = true;
  state.screen = 'export-running';
  state.busyLabel = 'Preparing ZIP preview';
  state.progress = { value: 0, total: 1, detail: 'Scanning project files' };
  controller.invalidate();
  try {
    const paths = custom
      ? await collectCustomExportPaths({
        project: state.project,
        signal: abortController.signal,
        onProgress: scanProgress(controller),
      })
      : await collectExportPaths({
        project: state.project,
        mode: state.exportDraft.mode,
        signal: abortController.signal,
        onProgress: scanProgress(controller),
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
    const sensitive = inspectPotentiallySensitivePaths(sortedPaths, { pathSizes });
    const annotations = custom ? await classifyCustomExportPaths(state.project, sortedPaths) : new Map();
    for (const record of sensitive) {
      if (!annotations.has(record.path)) annotations.set(record.path, { kind: record.category, reason: record.reason, excludedByDefault: true });
    }
    const selectedPaths = custom
      ? new Set(sortedPaths.filter((relative) => !annotations.get(relative)?.excludedByDefault))
      : new Set(sortedPaths);
    Object.assign(state.exportDraft, {
      paths: sortedPaths,
      selectedPaths,
      pathSizes,
      pathAnnotations: annotations,
      sensitive,
      sensitiveMap: sensitivePathMap(sensitive),
      sensitiveAcknowledged: custom || sensitive.length === 0,
    });
    updateSelectedSize(state.exportDraft);
    state.busy = false;
    state.exportAbortController = null;
    if (custom) return showExportFiles(controller, 0, { origin: 'mode' });
    if (sensitive.length) return showSensitiveReview(controller);
    return showExportPreview(controller);
  } catch (error) {
    state.busy = false;
    state.exportAbortController = null;
    if (error.code === 'cancelled') {
      controller.toast('ZIP preview preparation cancelled', 'info');
      return showExportMode(controller);
    }
    controller.message('Could not prepare ZIP preview', [error.message], 'error', { collapsedSummary: `ZIP preview failed · ${error.message}` });
    return showExportMode(controller);
  }
}

function scanProgress(controller) {
  return ({ current = 0, total = 0, detail = '' }) => {
    controller.state.progress = { value: current, total: Math.max(1, total || current + 1), detail: `Scanning · ${detail}` };
    controller.invalidate();
  };
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

function activateSensitiveReview(controller, itemId) {
  const draft = controller.state.exportDraft;
  if (itemId === 'export-sensitive-exclude') {
    for (const record of draft.sensitive) draft.selectedPaths.delete(record.path);
    draft.sensitiveAcknowledged = true;
    updateSelectedSize(draft);
    controller.toast(`${draft.sensitive.length} potentially sensitive files excluded`, 'success');
    return showExportPreview(controller);
  }
  if (itemId === 'export-sensitive-review') return showExportFiles(controller, null, { origin: 'sensitive', sensitiveOnly: true });
  if (itemId === 'export-sensitive-include') {
    draft.sensitiveAcknowledged = true;
    return showExportPreview(controller);
  }
  if (itemId === 'export-cancel') return controller.showHome();
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

function activateProtectedReview(controller, itemId) {
  const draft = controller.state.exportDraft;
  if (itemId === 'export-protected-include') {
    toggleTreeEntry(draft, draft.protectedPending);
    draft.protectedPending = null;
    updateSelectedSize(draft);
    return showExportFiles(controller, draft.treeReturnIndex ?? 0);
  }
  if (itemId === 'export-protected-back') {
    draft.protectedPending = null;
    return showExportFiles(controller, draft.treeReturnIndex ?? 0);
  }
}

function activateTreeItem(controller, itemId) {
  const draft = controller.state.exportDraft;
  if (itemId.startsWith('export-tree-directory:')) {
    enterTreeDirectory(draft, decodeURIComponent(itemId.slice('export-tree-directory:'.length)));
    return showExportFiles(controller, 0);
  }
  if (itemId.startsWith('export-tree-file:')) {
    requestTreeToggle(controller, decodeURIComponent(itemId.slice('export-tree-file:'.length)), controller.state.selectedIndex);
    return;
  }
  if (itemId === 'export-files-all') {
    selectRecommendedTreePaths(draft);
    updateSelectedSize(draft);
    return showExportFiles(controller);
  }
  if (itemId === 'export-files-none') {
    selectAllTreePaths(draft, false);
    updateSelectedSize(draft);
    return showExportFiles(controller);
  }
  if (itemId === 'export-files-back') return backExport(controller);
  if (itemId === 'export-files-continue') {
    if (draft.treeOrigin === 'sensitive') return showSensitiveReview(controller);
    if (hasUnacknowledgedSensitiveSelection(draft)) return showSensitiveReview(controller);
    return showExportPreview(controller);
  }
  if (itemId === 'export-choose-path') return proceedToExportPath(controller);
}

function requestTreeToggle(controller, entryPath, selectedIndex = null) {
  const draft = controller.state.exportDraft;
  if (isProtectedSelection(draft, entryPath)) {
    draft.protectedPending = entryPath;
    draft.treeReturnIndex = selectedIndex;
    return controller.showMenu('export-protected', [
      { id: 'export-protected-include', label: 'Include protected project data', description: 'Include the selected internal directory in this ZIP' },
      { id: 'export-protected-back', label: 'Back' },
    ], 'Include protected project data?', 1, [
      `${entryPath}/ contains Git or Zipflow internal state.`,
      'It can make the archive much larger and may expose repository or application metadata.',
    ]);
  }
  toggleTreeEntry(draft, entryPath);
  updateSelectedSize(draft);
  showExportFiles(controller, selectedIndex);
}

function isProtectedSelection(draft, entryPath) {
  const targets = draft.paths.filter((value) => value === entryPath || value.startsWith(`${entryPath}/`));
  if (!targets.length || targets.every((value) => draft.selectedPaths.has(value))) return false;
  return targets.some((value) => draft.pathAnnotations?.get(value)?.kind === 'protected');
}

function selectRecommendedTreePaths(draft) {
  const visible = draft.treeSensitiveOnly
    ? new Set(draft.sensitive.map((record) => record.path))
    : new Set(draft.paths);
  for (const relative of visible) {
    if (draft.pathAnnotations?.get(relative)?.excludedByDefault || draft.sensitiveMap?.has(relative)) draft.selectedPaths.delete(relative);
    else draft.selectedPaths.add(relative);
  }
  draft.sensitiveAcknowledged = true;
}

function showExportFiles(controller, selectedIndex = null, { origin = null, sensitiveOnly = null } = {}) {
  const draft = controller.state.exportDraft;
  if (origin !== null || sensitiveOnly !== null || draft.treeDirectory === undefined) {
    initializeExportTree(draft, {
      origin: origin ?? draft.treeOrigin ?? 'preview',
      sensitiveOnly: sensitiveOnly ?? false,
    });
  }
  const items = exportTreeItems(draft);
  items.push(
    { id: 'export-files-all', label: 'Select recommended files', description: 'Select visible safe, non-ignored files and leave flagged paths excluded' },
    { id: 'export-files-none', label: 'Clear selection', description: 'Exclude all files shown by this tree' },
    {
      id: 'export-files-continue',
      label: draft.treeOrigin === 'sensitive' ? 'Back to safety review' : 'Continue',
      description: `${draft.selectedPaths.size} files selected`,
      disabled: draft.selectedPaths.size === 0 && draft.treeOrigin !== 'sensitive',
    },
    { id: 'export-files-back', label: 'Back' },
  );
  controller.showMenu('export-files', items, draft.treeSensitiveOnly ? 'Review flagged files' : 'Choose included files', selectedIndex, [
    `${treeLocationLabel(draft)} · ${draft.selectedPaths.size} of ${draft.paths.length} files · ${formatBytes(draft.totalSize)}`,
    'Space toggles selection · Enter opens a folder · Shift+Tab or Left goes to the parent · Tab jumps to the next folder',
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
  ]);
}

function updateSelectedSize(draft) {
  draft.totalSize = [...draft.selectedPaths].reduce((total, filePath) => total + (draft.pathSizes.get(filePath) ?? 0), 0);
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
    placeholder: displayPath(draft.outputPath),
    purpose: 'export-path',
    context: 'Tab completes paths. Choose a directory to generate the archive filename automatically.',
  }, '');
}

async function createArchive(controller) {
  const { state } = controller;
  state.busy = true;
  state.screen = 'export-running';
  state.busyLabel = 'Creating ZIP archive';
  state.progress = { value: 0, total: 1, detail: 'Collecting files' };
  controller.invalidate();
  try {
    const paths = [...state.exportDraft.selectedPaths];
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

function modeLabel(mode) {
  if (mode === 'tracked') return 'Git-tracked files';
  if (mode === 'nonignored') return 'Non-ignored files';
  if (mode === 'interactive') return 'Custom selection';
  return 'Everything, including ignored files';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
