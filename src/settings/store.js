import path from 'node:path';
import { themes } from 'terlio.js';
import { readJson, removeIfExists, writeJsonAtomic } from '../utils/fs.js';
import { ensureZipflowHome, getZipflowHome } from '../workflow/store.js';
import { canonicalModelId, modelIdentityKey } from '../llm/model-identity.js';
import {
  deleteLlmApiToken, readLlmApiToken, SecureCredentialStoreError, writeLlmApiToken,
} from '../security/credential-store.js';

export const SETTINGS_VERSION = 17;
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
  interfaceLanguage: 'en',
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
  llmVerboseOutput: false,
  llmDecisionCompatibility: null,
  llmDecisionCompatibilityByModel: {},
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

let settingsWriteQueue = Promise.resolve();

const LEGACY_CREDENTIAL_KEYS = ['llmApiToken', 'apiToken', 'localLlmApiToken', 'llmToken'];

export async function loadSettings() {
  await settingsWriteQueue;
  await ensureZipflowHome();
  const [credentials, primary, backup] = await Promise.all([
    readSettingsFile(credentialsPath()),
    readSettingsFile(settingsPath()),
    readSettingsFile(settingsBackupPath()),
  ]);
  const source = primary ?? backup;
  const settings = normalizeSettings(source);
  const credentialMarker = containsLegacyCredential(credentials);
  const credentialRecords = primary
    ? credentialMarker ? [primary, credentials] : [primary, backup]
    : [backup, credentials];
  const credential = await resolveCredential(credentialRecords);
  const explicitLegacyClear = Boolean(primary)
    && credentialMarker
    && !firstLegacyToken([primary, credentials]);
  const restored = { ...settings, llmApiToken: credential.token };
  if (!primary && backup) await writeJsonAtomic(settingsPath(), settingsForDisk(restored, { legacyToken: credential.legacyOnDisk }));
  if (credential.secure || explicitLegacyClear) await scrubLegacyCredentials();
  return restored;
}

export function saveSettings(settings, { allowClearToken = false } = {}) {
  return enqueueSettingsWrite(async () => {
    const [stored, backup, credentials] = await Promise.all([
      readSettingsFile(settingsPath()),
      readSettingsFile(settingsBackupPath()),
      readSettingsFile(credentialsPath()),
    ]);
    const current = normalizeSettings(stored ?? backup);
    const credential = await resolveCredential(stored ? [stored, credentials] : [backup, credentials]);
    const incoming = normalizeSettings(settings);
    const requestedToken = incoming.llmApiToken;
    const credentialChange = await applyCredentialChange({
      requestedToken,
      currentToken: credential.token,
      currentSecure: credential.secure,
      allowClearToken,
    });
    return writeSettingsValue(normalizeSettings({ ...current, ...incoming, llmApiToken: credentialChange.token }), {
      currentRaw: stored,
      legacyToken: credentialChange.secure ? '' : credential.legacyOnDisk,
      secure: credentialChange.secure,
    });
  });
}

export function updateSettings(patch, { allowClearToken = false, baseSettings = null } = {}) {
  return enqueueSettingsWrite(async () => {
    const [stored, backup, credentials] = await Promise.all([
      readSettingsFile(settingsPath()),
      readSettingsFile(settingsBackupPath()),
      readSettingsFile(credentialsPath()),
    ]);
    const current = normalizeSettings({ ...(baseSettings ?? {}), ...(stored ?? backup ?? {}) });
    const credential = await resolveCredential(stored ? [stored, credentials, baseSettings] : [backup, credentials, baseSettings]);
    const nextPatch = { ...(patch ?? {}) };
    const tokenWasProvided = Object.prototype.hasOwnProperty.call(nextPatch, 'llmApiToken');
    let token = credential.token;
    let secure = credential.secure;
    if (tokenWasProvided) {
      const requestedToken = typeof nextPatch.llmApiToken === 'string' ? nextPatch.llmApiToken : '';
      if (requestedToken || allowClearToken) {
        const credentialChange = await applyCredentialChange({
          requestedToken,
          currentToken: credential.token,
          currentSecure: credential.secure,
          allowClearToken,
        });
        token = credentialChange.token;
        secure = credentialChange.secure;
      } else delete nextPatch.llmApiToken;
    }
    return writeSettingsValue(normalizeSettings({ ...current, ...nextPatch, llmApiToken: token }), {
      currentRaw: stored,
      legacyToken: secure ? '' : credential.legacyOnDisk,
      secure,
    });
  });
}

function enqueueSettingsWrite(task) {
  const result = settingsWriteQueue.then(task, task);
  settingsWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function writeSettingsValue(value, { currentRaw = null, legacyToken = '', secure = false } = {}) {
  await ensureZipflowHome();
  if (currentRaw) await writeJsonAtomic(settingsBackupPath(), settingsForDisk(currentRaw, { legacyToken }));
  await writeJsonAtomic(settingsPath(), settingsForDisk(value, { legacyToken }));
  if (secure) await scrubLegacyCredentials();
  return { ...value, llmApiToken: value.llmApiToken ?? '' };
}

async function applyCredentialChange({ requestedToken, currentToken, currentSecure, allowClearToken }) {
  const token = String(requestedToken ?? '');
  if (token) {
    if (token === currentToken) return { token, secure: currentSecure };
    await writeLlmApiToken(token);
    return { token, secure: true };
  }
  if (!allowClearToken) return { token: currentToken, secure: currentSecure };
  await deleteLlmApiToken();
  return { token: '', secure: true };
}

async function resolveCredential(records) {
  const legacyOnDisk = firstLegacyToken(records);
  let secureToken = '';
  let secureStoreAvailable = true;
  try {
    secureToken = await readLlmApiToken();
  } catch (error) {
    if (!(error instanceof SecureCredentialStoreError) || error.code !== 'credential-store-unavailable') throw error;
    secureStoreAvailable = false;
  }
  if (!secureToken && legacyOnDisk && secureStoreAvailable) {
    try {
      await writeLlmApiToken(legacyOnDisk);
      secureToken = legacyOnDisk;
    } catch (error) {
      if (!(error instanceof SecureCredentialStoreError) || error.code !== 'credential-store-unavailable') throw error;
      secureStoreAvailable = false;
    }
  }
  return {
    token: secureToken || legacyOnDisk,
    secure: Boolean(secureToken),
    legacyOnDisk: secureToken ? '' : legacyOnDisk,
  };
}

async function scrubLegacyCredentials() {
  await Promise.all([
    scrubSettingsCredential(settingsPath()),
    scrubSettingsCredential(settingsBackupPath()),
    removeIfExists(credentialsPath()),
  ]);
}

async function scrubSettingsCredential(target) {
  const value = await readSettingsFile(target);
  if (!value || !containsLegacyCredential(value)) return;
  await writeJsonAtomic(target, settingsForDisk(value));
}

function settingsForDisk(settings, { legacyToken = '' } = {}) {
  const value = normalizeSettings(settings);
  const disk = { ...value };
  for (const key of LEGACY_CREDENTIAL_KEYS) delete disk[key];
  if (legacyToken) disk.llmApiToken = legacyToken;
  return disk;
}

function firstLegacyToken(records) {
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    for (const key of LEGACY_CREDENTIAL_KEYS) {
      if (typeof record[key] === 'string' && record[key]) return record[key];
    }
  }
  return '';
}

function containsLegacyCredential(value) {
  if (!value || typeof value !== 'object') return false;
  return LEGACY_CREDENTIAL_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function normalizeSettings(settings) {
  const raw = settings && typeof settings === 'object' ? settings : {};
  const source = migrateLegacySettingAliases(raw);
  const value = { ...DEFAULT_SETTINGS, ...source, version: SETTINGS_VERSION };
  if (typeof value.interfaceLanguage !== 'string' || !value.interfaceLanguage.trim()) value.interfaceLanguage = DEFAULT_SETTINGS.interfaceLanguage;
  value.interfaceLanguage = value.interfaceLanguage.trim().toLowerCase();
  if (!THEME_NAMES.includes(value.theme)) value.theme = DEFAULT_SETTINGS.theme;
  if (!['compact', 'last-line'].includes(value.checkOutput)) value.checkOutput = DEFAULT_SETTINGS.checkOutput;
  if (!LLM_PROVIDERS.includes(value.llmProvider)) value.llmProvider = DEFAULT_SETTINGS.llmProvider;
  if (typeof value.llmModel !== 'string') value.llmModel = '';
  value.llmModel = canonicalModelId(value.llmProvider, value.llmModel);
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
  value.llmVerboseOutput = value.llmVerboseOutput === true;
  value.llmDecisionCompatibilityByModel = normalizeCompatibilityMap(value.llmDecisionCompatibilityByModel);
  const legacyCompatibility = normalizeDecisionCompatibility(value.llmDecisionCompatibility, value);
  if (legacyCompatibility) value.llmDecisionCompatibilityByModel[modelIdentityKey(value.llmProvider, value.llmModel)] = legacyCompatibility;
  value.llmDecisionCompatibility = value.llmDecisionCompatibilityByModel[modelIdentityKey(value.llmProvider, value.llmModel)] ?? null;
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



function migrateLegacySettingAliases(source) {
  const value = { ...source };
  const aliases = {
    llmApiToken: ['apiToken', 'localLlmApiToken', 'llmToken'],
    llmProvider: ['localLlmProvider'],
    llmModel: ['localLlmModel', 'selectedModel'],
    archivePolicy: ['sourceArchivePolicy', 'archiveDispositionPolicy'],
    archiveDirectory: ['sourceArchiveDirectory'],
    archiveRetentionDays: ['sourceArchiveRetentionDays'],
    archiveMaxBytes: ['sourceArchiveMaxBytes'],
    backupMaxBytes: ['backupStorageMaxBytes'],
  };
  for (const [target, names] of Object.entries(aliases)) {
    if (Object.prototype.hasOwnProperty.call(value, target)) continue;
    const found = names.find((name) => Object.prototype.hasOwnProperty.call(value, name));
    if (found) value[target] = value[found];
  }
  return value;
}

function normalizeCompatibilityMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, record] of Object.entries(value)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    result[key] = {
      provider: typeof record.provider === 'string' ? record.provider : '',
      model: typeof record.model === 'string' ? record.model : '',
      supported: Boolean(record.supported),
      testedAt: typeof record.testedAt === 'string' ? record.testedAt : null,
      error: typeof record.error === 'string' ? record.error : null,
    };
  }
  return result;
}

function normalizeDecisionCompatibility(value, settings) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const provider = typeof value.provider === 'string' ? value.provider : '';
  const model = canonicalModelId(provider, typeof value.model === 'string' ? value.model : '');
  if (!provider || !model || provider !== settings.llmProvider || model !== canonicalModelId(settings.llmProvider, settings.llmModel)) return null;
  return {
    provider,
    model,
    supported: Boolean(value.supported),
    testedAt: typeof value.testedAt === 'string' ? value.testedAt : null,
    error: typeof value.error === 'string' ? value.error : null,
  };
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
  if (value === 'Ukrainian') return fallback;
  return LLM_LANGUAGES.includes(value) ? value : fallback;
}

export function settingsPath() {
  return path.join(getZipflowHome(), 'settings.json');
}

export function settingsBackupPath() {
  return path.join(getZipflowHome(), 'settings.backup.json');
}

export function credentialsPath() {
  return path.join(getZipflowHome(), 'credentials.json');
}

async function readSettingsFile(target) {
  try {
    return await readJson(target, null);
  } catch {
    return null;
  }
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
