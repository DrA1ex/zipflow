import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { ensureZipflowHome, getZipflowHome } from '../workflow/store.js';

export const GIT_HOOK_POLICIES = Object.freeze(['disabled', 'allow']);

const EMPTY_HOOKS_OWNER = `${process.pid}-${randomUUID()}`;

export function gitHooksAllowed(workflow) {
  return workflow?.git?.hooks === 'allow';
}

export function gitHooksSettingAvailable(state) {
  return Boolean(state?.setupEditing && state?.setupSection === 'git');
}

export async function disabledGitHooksPath() {
  await ensureZipflowHome();
  const target = path.join(getZipflowHome(), 'internal', 'empty-git-hooks', EMPTY_HOOKS_OWNER);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  return target;
}

export async function gitArgumentsWithHookPolicy(args, { allowHooks = true } = {}) {
  if (allowHooks) return [...args];
  const hooksPath = await disabledGitHooksPath();
  return ['-c', `core.hooksPath=${hooksPath}`, ...args];
}
