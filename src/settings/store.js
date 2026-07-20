import path from 'node:path';
import { themes } from 'terlio.js';
import { readJson, writeJsonAtomic } from '../utils/fs.js';
import { ensureZipflowHome, getZipflowHome } from '../workflow/store.js';

export const SETTINGS_VERSION = 7;
export const THEME_NAMES = Object.keys(themes);
export const LLM_PROVIDERS = ['disabled', 'ollama', 'lmstudio'];
export const LLM_LANGUAGES = ['English', 'Russian', 'German', 'French', 'Spanish', 'Chinese', 'Japanese'];
export const ARCHIVE_POLICIES = ['keep', 'move', 'delete'];
export const LLM_ARCHIVE_REVIEW_MODES = ['disabled', 'structure', 'patch'];
export const LLM_CHANGE_DELIVERY_MODES = ['adaptive', 'patch', 'change-list', 'chunked'];
export const LLM_FAILURE_ANALYSIS_MODES = ['disabled', 'same-context', 'new-context'];

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  theme: 'ocean',
  checkOutput: 'last-line',
  llmProvider: 'disabled',
  llmModel: '',
  llmLanguage: 'English',
  llmApiToken: '',
  llmArchiveReview: 'disabled',
  llmChangeDelivery: 'adaptive',
  llmFailureAnalysis: 'disabled',
  llmModelLoadConfigs: {},
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
  if (!LLM_CHANGE_DELIVERY_MODES.includes(value.llmChangeDelivery)) value.llmChangeDelivery = DEFAULT_SETTINGS.llmChangeDelivery;
  if (!LLM_FAILURE_ANALYSIS_MODES.includes(value.llmFailureAnalysis)) value.llmFailureAnalysis = DEFAULT_SETTINGS.llmFailureAnalysis;
  value.llmModelLoadConfigs = normalizeModelLoadConfigs(value.llmModelLoadConfigs);
  if (value.llmProvider === 'disabled') value.llmModel = '';
  if (!ARCHIVE_POLICIES.includes(value.archivePolicy)) value.archivePolicy = DEFAULT_SETTINGS.archivePolicy;
  if (typeof value.archiveDirectory !== 'string' || !value.archiveDirectory.trim()) value.archiveDirectory = DEFAULT_SETTINGS.archiveDirectory;
  value.archiveRetentionDays = normalizeInteger(value.archiveRetentionDays, DEFAULT_SETTINGS.archiveRetentionDays, 0, 36_500);
  value.archiveMaxBytes = normalizeInteger(value.archiveMaxBytes, DEFAULT_SETTINGS.archiveMaxBytes, 0, Number.MAX_SAFE_INTEGER);
  return value;
}

function normalizeModelLoadConfigs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, config] of Object.entries(value)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    result[key] = {
      contextLength: normalizeOptionalInteger(config.contextLength, 256, 2_000_000),
      evalBatchSize: normalizeOptionalInteger(config.evalBatchSize, 1, 65_536),
      flashAttention: normalizeOptionalBoolean(config.flashAttention),
      offloadKvCacheToGpu: normalizeOptionalBoolean(config.offloadKvCacheToGpu),
      numExperts: normalizeOptionalInteger(config.numExperts, 1, 10_000),
    };
  }
  return result;
}

function normalizeOptionalInteger(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeOptionalBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

export function settingsPath() {
  return path.join(getZipflowHome(), 'settings.json');
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
