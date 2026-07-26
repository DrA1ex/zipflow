export class SettingsConflictError extends Error {
  constructor(message = 'Settings changed in another Zipflow instance. Reload the settings and try again.') {
    super(message);
    this.name = 'SettingsConflictError';
    this.code = 'settings_conflict';
  }
}

export function normalizeStorageRevision(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function assertFullSettingsCas(incoming, current, { currentExists = true } = {}) {
  const hasRevision = Object.prototype.hasOwnProperty.call(incoming ?? {}, 'storageRevision');
  if (!hasRevision) {
    if (currentExists && normalizeStorageRevision(current?.storageRevision) > 0) throw new SettingsConflictError();
    return;
  }
  if (normalizeStorageRevision(incoming.storageRevision) !== normalizeStorageRevision(current?.storageRevision)) {
    throw new SettingsConflictError();
  }
}

export function assertPatchSettingsCas(current, patch, baseSettings) {
  if (!baseSettings
    || normalizeStorageRevision(baseSettings.storageRevision) === normalizeStorageRevision(current?.storageRevision)) return;
  for (const key of Object.keys(patch ?? {})) {
    if (key === 'storageRevision' || key === 'version') continue;
    if (key === 'llmApiToken') throw new SettingsConflictError();
    if (sameSettingValue(current?.[key], baseSettings[key]) || sameSettingValue(current?.[key], patch[key])) continue;
    throw new SettingsConflictError(`The ${key} setting changed in another Zipflow instance. Reload the settings and try again.`);
  }
}

export function nextStorageRevision(current) {
  return normalizeStorageRevision(current?.storageRevision) + 1;
}

function sameSettingValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
