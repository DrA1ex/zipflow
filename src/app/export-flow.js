import path from 'node:path';
import { stat } from 'node:fs/promises';
import { copyTextToClipboard } from 'terlio.js';
import { collectExportPaths, listExportTopLevel } from '../export/candidates.js';
import { createProjectArchive } from '../export/create.js';
import { displayPath, parseEnteredPath } from '../utils/paths.js';
import { runProcess } from '../utils/process.js';

export function handlesExportScreen(screen) {
  return ['export-mode', 'export-select', 'export-preview', 'export-files', 'export-path', 'export-running', 'export-complete'].includes(screen);
}

export function beginCreateZip(controller) {
  controller.state.exportDraft = {
    mode: null,
    topLevel: [],
    selectedRoots: new Set(),
    outputPath: defaultArchivePath(controller.state.project),
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
  if (state.screen === 'export-preview') {
    if (itemId === 'export-choose-path') return showExportPath(controller);
    if (itemId === 'export-review-files') return showExportFiles(controller);
    if (itemId === 'export-change-mode') return showExportMode(controller);
    if (itemId === 'export-cancel') return controller.showHome();
  }
  if (state.screen === 'export-files') {
    if (itemId === 'export-files-back') return showExportPreview(controller);
    if (itemId === 'export-choose-path') return showExportPath(controller);
  }
  if (state.screen === 'export-complete') {
    if (itemId === 'export-copy-path') {
      const copied = await copyTextToClipboard(state.exportDraft.result.outputPath, { output: controller.runtime?.output });
      return controller.setStatus(copied ? 'ZIP path copied' : 'Clipboard transfer unavailable');
    }
    if (itemId === 'export-open-folder') return openArchiveLocation(controller);
    if (itemId === 'export-again') return beginCreateZip(controller);
    if (itemId === 'export-home') return controller.showHome();
  }
}

export function handleExportShortcut(controller, key) {
  const { state } = controller;
  if (state.screen !== 'export-select') return false;
  const selected = state.menuItems[state.selectedIndex];
  if (key.name === 'space' && selected?.id.startsWith('export-item:')) {
    toggleExportItem(controller, selected.id.slice(12), state.selectedIndex);
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
      label: 'Only Git-tracked files',
      description: git ? 'Create the smallest reproducible archive from files already tracked by Git.' : 'Initialize Git first to use this mode.',
      disabled: !git,
    },
    { id: 'export-nonignored', label: 'All files except ignored', description: 'Include tracked and untracked files, but leave out paths matched by .gitignore.' },
    { id: 'export-interactive', label: 'Choose top-level items', description: 'Select project folders and files from a compact top-level list.' },
    { id: 'export-all', label: 'All project files', description: 'Include ignored files too. .git/ and .zipflow/ always remain protected.' },
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
  const paths = await collectExportPaths({
    project: state.project,
    mode: state.exportDraft.mode,
    selectedRoots: [...state.exportDraft.selectedRoots],
  });
  let totalSize = 0;
  for (const relative of paths) totalSize += (await stat(path.join(state.project.root, relative))).size;
  state.exportDraft.paths = paths;
  state.exportDraft.totalSize = totalSize;
  return showExportPreview(controller);
}

function showExportPreview(controller) {
  const draft = controller.state.exportDraft;
  controller.showMenu('export-preview', [
    { id: 'export-choose-path', label: 'Choose output path and create ZIP', description: draft.outputPath },
    { id: 'export-review-files', label: 'Review included files', description: `${draft.paths.length} files selected` },
    { id: 'export-change-mode', label: 'Change export mode', description: modeLabel(draft.mode) },
    { id: 'export-cancel', label: 'Cancel' },
  ], 'Review ZIP contents', 0, [
    `${draft.paths.length} files · ${formatBytes(draft.totalSize)}`,
    `Mode: ${modeLabel(draft.mode)}`,
    '.git/ and .zipflow/ remain protected in every export mode.',
  ]);
}

function showExportFiles(controller) {
  const draft = controller.state.exportDraft;
  const items = draft.paths.map((relative) => ({ id: `export-file:${relative}`, label: relative, description: 'Included in this ZIP' }));
  items.push(
    { id: 'export-files-back', label: 'Back to ZIP preview' },
    { id: 'export-choose-path', label: 'Choose output path and create ZIP' },
  );
  controller.showMenu('export-files', items, 'Included files', null, [
    `${draft.paths.length} files · ${formatBytes(draft.totalSize)}`,
    'This list is read-only. Return to the previous step to change the export mode or interactive selection.',
  ]);
}

async function openArchiveLocation(controller) {
  const target = controller.state.exportDraft.result.outputPath;
  try {
    if (process.platform === 'darwin') await runProcess('open', ['-R', target]);
    else if (process.platform === 'linux') await runProcess('xdg-open', [path.dirname(target)]);
    else return controller.setStatus('Opening the containing folder is not supported on this platform.');
    controller.setStatus('Opened archive location');
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
    const paths = state.exportDraft.paths ?? await collectExportPaths({
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

function defaultArchivePath(project) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
  return path.join(path.dirname(project.root), `${safeName(project.name)}-${stamp}.zip`);
}

function safeName(value) {
  return String(value || 'project').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function modeLabel(mode) {
  if (mode === 'tracked') return 'Only Git-tracked files';
  if (mode === 'nonignored') return 'All files except ignored';
  if (mode === 'interactive') return 'Selected top-level items';
  return 'All project files';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
