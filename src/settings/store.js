import path from 'node:path';
import { themes } from 'terlio.js';
import { readJson, writeJsonAtomic } from '../utils/fs.js';
import { ensureZipflowHome, getZipflowHome } from '../workflow/store.js';

export const SETTINGS_VERSION = 2;
export const THEME_NAMES = Object.keys(themes);
export const LLM_PROVIDERS = ['disabled', 'ollama', 'lmstudio'];
export const LLM_LANGUAGES = ['English', 'Russian', 'German', 'French', 'Spanish', 'Chinese', 'Japanese'];

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  theme: 'ocean',
  checkOutput: 'last-line',
  llmProvider: 'disabled',
  llmModel: '',
  llmLanguage: 'English',
});

export async function loadSettings() {
  await ensureZipflowHome();
  const stored = await readJson(settingsPath(), null);
  return normalizeSettings(stored);
}

export async function saveSettings(settings) {
  await ensureZipflowHome();
  const value = normalizeSettings(settings);
  await writeJsonAtomic(settingsPath(), value);
  return value;
}

export function normalizeSettings(settings) {
  const value = { ...DEFAULT_SETTINGS, ...(settings ?? {}), version: SETTINGS_VERSION };
  if (!THEME_NAMES.includes(value.theme)) value.theme = DEFAULT_SETTINGS.theme;
  if (!['compact', 'last-line'].includes(value.checkOutput)) value.checkOutput = DEFAULT_SETTINGS.checkOutput;
  if (!LLM_PROVIDERS.includes(value.llmProvider)) value.llmProvider = DEFAULT_SETTINGS.llmProvider;
  if (typeof value.llmModel !== 'string') value.llmModel = '';
  if (!LLM_LANGUAGES.includes(value.llmLanguage)) value.llmLanguage = DEFAULT_SETTINGS.llmLanguage;
  if (value.llmProvider === 'disabled') value.llmModel = '';
  return value;
}

export function settingsPath() {
  return path.join(getZipflowHome(), 'settings.json');
}
