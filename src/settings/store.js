import path from 'node:path';
import { themes } from 'terlio.js';
import { readJson, writeJsonAtomic } from '../utils/fs.js';
import { ensureZipflowHome, getZipflowHome } from '../workflow/store.js';

export const SETTINGS_VERSION = 11;
export const THEME_NAMES = Object.keys(themes);
export const LLM_PROVIDERS = ['disabled', 'ollama', 'lmstudio'];
export const LLM_LANGUAGES = ['English', 'Russian', 'German', 'French', 'Spanish', 'Chinese', 'Japanese'];
export const ARCHIVE_POLICIES = ['keep', 'move', 'delete'];
export const LLM_ARCHIVE_REVIEW_MODES = ['disabled', 'structure', 'sample', 'patch'];
export const LLM_CHANGE_DELIVERY_MODES = ['adaptive', 'patch', 'representative', 'capped', 'change-list', 'chunked'];
export const LLM_FAILURE_ANALYSIS_MODES = ['disabled', 'same-context', 'new-context'];
export const BACKUP_RETENTION_POLICIES = ['all', 'limits'];
export const MANAGED_HISTORY_POLICIES = ['record', 'disabled'];

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  theme: 'ocean',
  checkOutput: 'last-line',
  llmProvider: 'disabled',
  llmModel: '',
  llmLanguage: 'English',
  llmPromptLanguage: 'English',
  llmSummaryLanguage: 'English',
  llmCommitLanguage: 'English',
  llmSelectedInstanceId: '',
  llmApiToken: '',
  llmArchiveReview: 'disabled',
  llmChangeDelivery: 'adaptive',
  llmFailureAnalysis: 'disabled',
  llmModelLoadConfigs: {},
  archivePolicy: 'keep',
  archiveDirectory: '~/zipflow-archive',
  archiveRetentionDays: 30,
  archiveMaxBytes: 1_000_000_000,
  backupRetentionPolicy: 'limits',
  backupRetentionDays: 30,
  backupMaxBytes: 2_000_000_000,
  managedHistoryPolicy: 'record',
  recentArchivePaths: [],
  lastArchiveDirectory: '',
  lastExportDirectory: '',
  lastDiffMode: 'unified',
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
  const source = settings && typeof settings === 'object' ? settings : {};
  const value = { ...DEFAULT_SETTINGS, ...source, version: SETTINGS_VERSION };
  if (!THEME_NAMES.includes(value.theme)) value.theme = DEFAULT_SETTINGS.theme;
  if (!['compact', 'last-line'].includes(value.checkOutput)) value.checkOutput = DEFAULT_SETTINGS.checkOutput;
  if (!LLM_PROVIDERS.includes(value.llmProvider)) value.llmProvider = DEFAULT_SETTINGS.llmProvider;
  if (typeof value.llmModel !== 'string') value.llmModel = '';
  const legacyLanguage = normalizeLanguage(value.llmLanguage, DEFAULT_SETTINGS.llmLanguage);
  const hasSplitLanguages = ['llmPromptLanguage', 'llmSummaryLanguage', 'llmCommitLanguage']
    .some((key) => Object.prototype.hasOwnProperty.call(source, key));
  const isLegacySettings = Number(source.version || 0) < SETTINGS_VERSION && !hasSplitLanguages;
  value.llmPromptLanguage = normalizeLanguage(
    isLegacySettings ? DEFAULT_SETTINGS.llmPromptLanguage : value.llmPromptLanguage,
    DEFAULT_SETTINGS.llmPromptLanguage,
  );
  value.llmSummaryLanguage = normalizeLanguage(
    isLegacySettings ? legacyLanguage : value.llmSummaryLanguage,
    legacyLanguage,
  );
  value.llmCommitLanguage = normalizeLanguage(
    isLegacySettings ? legacyLanguage : value.llmCommitLanguage,
    legacyLanguage,
  );
  value.llmLanguage = value.llmSummaryLanguage;
  if (typeof value.llmSelectedInstanceId !== 'string') value.llmSelectedInstanceId = '';
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
  if (!BACKUP_RETENTION_POLICIES.includes(value.backupRetentionPolicy)) value.backupRetentionPolicy = DEFAULT_SETTINGS.backupRetentionPolicy;
  value.backupRetentionDays = normalizeInteger(value.backupRetentionDays, DEFAULT_SETTINGS.backupRetentionDays, 0, 36_500);
  value.backupMaxBytes = normalizeInteger(value.backupMaxBytes, DEFAULT_SETTINGS.backupMaxBytes, 0, Number.MAX_SAFE_INTEGER);
  if (!MANAGED_HISTORY_POLICIES.includes(value.managedHistoryPolicy)) value.managedHistoryPolicy = DEFAULT_SETTINGS.managedHistoryPolicy;
  value.recentArchivePaths = normalizeRecentPaths(value.recentArchivePaths);
  if (typeof value.lastArchiveDirectory !== 'string') value.lastArchiveDirectory = '';
  if (typeof value.lastExportDirectory !== 'string') value.lastExportDirectory = '';
  if (!['unified', 'side-by-side'].includes(value.lastDiffMode)) value.lastDiffMode = DEFAULT_SETTINGS.lastDiffMode;
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

function normalizeLanguage(value, fallback) {
  return LLM_LANGUAGES.includes(value) ? value : fallback;
}

export function settingsPath() {
  return path.join(getZipflowHome(), 'settings.json');
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeRecentPaths(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))].slice(0, 5);
}
