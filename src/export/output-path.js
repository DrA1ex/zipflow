import path from 'node:path';
import { stat } from 'node:fs/promises';
import { parseEnteredPath } from '../utils/paths.js';

export function defaultArchivePath(project, settings = {}, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
  const directory = settings.lastExportDirectory || path.dirname(project.root);
  return path.join(directory, `${safeName(project.name)}-${stamp}.zip`);
}

export function outputPathForDirectory(directory, project, currentDefault = '') {
  const filename = path.basename(String(currentDefault || defaultArchivePath(project)));
  return path.join(directory, filename.toLowerCase().endsWith('.zip') ? filename : `${filename}.zip`);
}

export async function normalizeOutputArchivePath(value, { cwd, project, settings = {}, currentDefault = '' } = {}) {
  let target = parseEnteredPath(value, cwd);
  try {
    if ((await stat(target)).isDirectory()) target = outputPathForDirectory(target, project, currentDefault || defaultArchivePath(project, settings));
  } catch {
    // A new output path does not exist yet.
  }
  if (!target.toLowerCase().endsWith('.zip')) target += '.zip';
  return path.normalize(target);
}

function safeName(value) {
  return String(value || 'project').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}
