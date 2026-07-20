import { inspectPotentiallySensitivePath } from '../export/sensitive.js';
import { normalizeRelativePath } from './matcher.js';

const PROTECTED_CONTROL_FILES = new Map([
  ['.gitignore', 'protected Git ignore rules are never removed by snapshot deletion'],
]);

export function deletionProtectionReason(relativePath) {
  const normalized = normalizeRelativePath(relativePath).replace(/\/$/, '');
  if (!normalized) return null;
  const controlReason = PROTECTED_CONTROL_FILES.get(normalized.toLowerCase());
  if (controlReason) return controlReason;
  const sensitive = inspectPotentiallySensitivePath(normalized);
  if (!sensitive || !['sensitive', 'private-data'].includes(sensitive.category)) return null;
  return `protected local data kept: ${sensitive.reason}`;
}

export function isDeletionProtectedProjectPath(relativePath) {
  return Boolean(deletionProtectionReason(relativePath));
}
