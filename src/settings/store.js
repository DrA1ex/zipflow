import path from 'node:path';
import { themes } from 'terlio.js';
import { readJson, writeJsonAtomic } from '../utils/fs.js';
import { ensureZipflowHome, getZipflowHome } from '../workflow/store.js';

export const SETTINGS_VERSION = 5;
export const THEME_NAMES = Object.keys(themes);
export const LLM_PROVIDERS = ['disabled', 'ollama', 'lmstudio'];
export const LLM_LANGUAGES = ['English', 'Russian', 'German', 'French', 'Spanish', 'Chinese', 'Japanese'];
export const ARCHIVE_POLICIES = ['keep', 'move', 'delete'];
export const LLM_ARCHIVE_REVIEW_MODES = ['disabled', 'structure', 'patch'];

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  theme: 'ocean',
  checkOutput: 'last-line',
  llmProvider: 'disabled',
  llmModel: '',
  llmLanguage: 'English',
  llmApiToken: '',
  llmArchiveReview: 'disabled',
  archivePolicy: 'keep',
  archiveDirectory: '~/zipflow-archive',
  archiveRetentionDays: 30,
  archiveMaxBytes: 1_000_000_000,
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
  if (typeof value.llmApiToken !== 'string') value.llmApiToken = '';
  if (!LLM_ARCHIVE_REVIEW_MODES.includes(value.llmArchiveReview)) value.llmArchiveReview = DEFAULT_SETTINGS.llmArchiveReview;
  if (value.llmProvider === 'disabled') value.llmModel = '';
  if (!ARCHIVE_POLICIES.includes(value.archivePolicy)) value.archivePolicy = DEFAULT_SETTINGS.archivePolicy;
  if (typeof value.archiveDirectory !== 'string' || !value.archiveDirectory.trim()) value.archiveDirectory = DEFAULT_SETTINGS.archiveDirectory;
  value.archiveRetentionDays = normalizeInteger(value.archiveRetentionDays, DEFAULT_SETTINGS.archiveRetentionDays, 0, 36_500);
  value.archiveMaxBytes = normalizeInteger(value.archiveMaxBytes, DEFAULT_SETTINGS.archiveMaxBytes, 0, Number.MAX_SAFE_INTEGER);
  return value;
}

export function settingsPath() {
  return path.join(getZipflowHome(), 'settings.json');
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
