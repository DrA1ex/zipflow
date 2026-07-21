import path from 'node:path';
import { exists } from '../utils/fs.js';
import { suggestPathEntries } from '../utils/paths.js';
import { outputPathForDirectory } from '../export/output-path.js';

const PATH_SCREENS = new Set(['project-path-input', 'archive-input', 'export-path']);

export async function showRecentArchiveSuggestions(controller) {
  const { state } = controller;
  const recent = state.settings?.recentArchivePaths ?? [];
  const available = [];
  for (const archivePath of recent) {
    if (await exists(archivePath)) available.push({
      id: `recent:${archivePath}`,
      label: path.basename(archivePath),
      insert: archivePath,
      isDirectory: false,
      submit: true,
    });
  }
  if (!available.length) return false;
  state.pathSuggestionActive = true;
  state.pathSuggestions = {
    requestId: 0,
    loading: false,
    items: available,
    selectedIndex: 0,
    owner: 'archive-input',
  };
  state.status = 'Recent archives · Enter selects';
  controller.invalidate();
  return true;
}

export function isPathEditorScreen(screen) {
  return PATH_SCREENS.has(screen);
}

export async function refreshPathSuggestions(controller, { settingsModal = false } = {}) {
  const { state } = controller;
  if (!state.pathSuggestionActive || !String(state.editor.value ?? '').trim()) {
    state.pathSuggestions = null;
    return;
  }
  const spec = pathSuggestionSpec(state, settingsModal);
  if (!spec) {
    state.pathSuggestions = null;
    return;
  }
  const requestId = (state.pathSuggestions?.requestId ?? 0) + 1;
  state.pathSuggestions = {
    requestId,
    loading: true,
    items: state.pathSuggestions?.items ?? [],
    selectedIndex: state.pathSuggestions?.selectedIndex ?? 0,
    owner: spec.owner,
  };
  controller.invalidate();
  try {
    let items = await suggestPathEntries(state.editor.value, spec.options);
    if (spec.owner === 'export-path') {
      items = items.map((item) => item.id.startsWith('use:')
        ? {
            ...item,
            insert: outputPathForDirectory(item.path, state.project, state.exportDraft?.outputPath),
            label: `Use ${path.basename(item.path) || item.path} and generate ZIP name`,
            detail: 'AUTO',
            description: 'Generate the default archive filename in this directory.',
            submit: true,
          }
        : item);
    }
    if (state.pathSuggestions?.requestId !== requestId) return;
    const previousId = state.pathSuggestions.items?.[state.pathSuggestions.selectedIndex]?.id;
    const selectedIndex = Math.max(0, items.findIndex((item) => item.id === previousId));
    state.pathSuggestions = { requestId, loading: false, items, selectedIndex, owner: spec.owner };
  } catch (error) {
    if (state.pathSuggestions?.requestId !== requestId) return;
    state.pathSuggestions = { requestId, loading: false, items: [], selectedIndex: 0, owner: spec.owner, error: error.message };
  }
  controller.invalidate();
}

export function clearPathSuggestions(state) {
  state.pathSuggestions = null;
}

export function resetPathSuggestionInput(state) {
  state.pathSuggestionActive = false;
  clearPathSuggestions(state);
}

export function movePathSuggestion(state, delta) {
  const completion = state.pathSuggestions;
  if (!completion?.items?.length) return false;
  completion.selectedIndex = (completion.selectedIndex + delta + completion.items.length) % completion.items.length;
  return true;
}

export async function acceptPathSuggestion(controller, { submit, submitSelected = false } = {}) {
  const { state } = controller;
  const completion = state.pathSuggestions;
  const item = completion?.items?.[completion.selectedIndex];
  if (!item) return false;
  state.editor.set(item.insert);
  if (item.submit) {
    clearPathSuggestions(state);
    state.status = 'Path selected · press Enter to continue';
    if (submitSelected && typeof submit === 'function') await submit();
    return true;
  }
  await refreshPathSuggestions(controller, { settingsModal: completion.owner === 'settings-modal' });
  state.status = item.submit ? 'Path selected' : 'Directory opened';
  return true;
}

export function selectPathSuggestion(state, index) {
  const completion = state.pathSuggestions;
  if (!completion?.items?.length) return false;
  completion.selectedIndex = Math.max(0, Math.min(index, completion.items.length - 1));
  return true;
}

function pathSuggestionSpec(state, settingsModal) {
  if (settingsModal) {
    const field = state.settingsPanel?.modal?.field;
    if (!field?.path) return null;
    return {
      owner: 'settings-modal',
      options: {
        cwd: state.project?.root ?? process.cwd(),
        directoriesOnly: true,
        includeCurrentDirectory: true,
      },
    };
  }
  if (state.screen === 'project-path-input') return {
    owner: state.screen,
    options: {
      cwd: state.project?.root ?? process.cwd(),
      directoriesOnly: true,
      includeCurrentDirectory: true,
    },
  };
  if (state.screen === 'archive-input') return {
    owner: state.screen,
    options: {
      cwd: state.project?.root ?? process.cwd(),
      extension: '.zip',
    },
  };
  if (state.screen === 'export-path') return {
    owner: state.screen,
    options: {
      cwd: state.settings?.lastExportDirectory || path.dirname(state.project?.root ?? process.cwd()),
      extension: '.zip',
      includeCurrentDirectory: true,
    },
  };
  return null;
}
