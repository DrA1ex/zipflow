import { normalizeRelativePath } from '../plan/matcher.js';

const PROTECTED_ROOTS = new Set(['.git', '.zipflow']);

export function isProtectedProjectPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath).replace(/\/$/, '');
  if (!normalized) return false;
  const root = normalized.split('/')[0].toLowerCase();
  return PROTECTED_ROOTS.has(root);
}

export function protectedRootNames() {
  return [...PROTECTED_ROOTS];
}
