import path from 'node:path';
import { collectExportPaths, listExportTopLevel } from '../export/candidates.js';
import { createProjectArchive } from '../export/create.js';
import { displayPath, parseEnteredPath } from '../utils/paths.js';

export function handlesExportScreen(screen) {
  return ['export-mode', 'export-select', 'export-path', 'export-running', 'export-complete'].includes(screen);
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
    return showExportPath(controller);
  }
  if (state.screen === 'export-select') {
    if (itemId.startsWith('export-item:')) return toggleExportItem(controller, itemId.slice(12));
    if (itemId === 'export-select-all') return selectAll(controller, true);
    if (itemId === 'export-select-none') return selectAll(controller, false);
    if (itemId === 'export-select-continue') return showExportPath(controller);
    if (itemId === 'export-cancel') return controller.showHome();
  }
  if (state.screen === 'export-complete') {
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
  if (screen === 'export-path') {
    return controller.state.exportDraft.mode === 'interactive' ? showInteractiveSelection(controller) : showExportMode(controller);
  }
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
    const paths = await collectExportPaths({
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
      { id: 'export-again', label: 'Create another ZIP' },
      { id: 'export-home', label: 'Return to project' },
    ], 'Archive ready');
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
