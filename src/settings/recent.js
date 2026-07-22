import path from 'node:path';
import { updateSettings } from './store.js';

const MAX_RECENT_ARCHIVES = 5;

export async function rememberArchivePath(state, archivePath) {
  const absolute = path.resolve(String(archivePath));
  const recent = [absolute, ...(state.settings.recentArchivePaths ?? []).filter((item) => item !== absolute)]
    .slice(0, MAX_RECENT_ARCHIVES);
  state.settings = await updateSettings({
    recentArchivePaths: recent,
    lastArchiveDirectory: path.dirname(absolute),
  }, { baseSettings: state.settings });
  return state.settings;
}

export async function rememberExportPath(state, outputPath) {
  const absolute = path.resolve(String(outputPath));
  state.settings = await updateSettings({ lastExportDirectory: path.dirname(absolute) }, { baseSettings: state.settings });
  return state.settings;
}

export async function rememberDiffMode(state, mode) {
  if (!['unified', 'side-by-side'].includes(mode)) return state.settings;
  state.settings = await updateSettings({ lastDiffMode: mode }, { baseSettings: state.settings });
  return state.settings;
}

export function recentArchiveHint(settings, { limit = 3 } = {}) {
  const entries = (settings?.recentArchivePaths ?? []).slice(0, limit);
  if (!entries.length) return '';
  return `Recent: ${entries.map((item) => path.basename(item)).join(' · ')}`;
}
