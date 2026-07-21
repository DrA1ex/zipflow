import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

export async function assertSafeProjectPath(projectRoot, relativePath, {
  allowMissingLeaf = true,
  requireFile = false,
} = {}) {
  const normalized = normalizeRelative(relativePath);
  const root = path.resolve(projectRoot);
  const canonicalRoot = await realpath(root);
  const segments = normalized.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!allowMissingLeaf || index < segments.length - 1) {
        if (index < segments.length - 1) {
          // Once a component is missing, descendants cannot hide a symlink yet. The
          // last existing parent has already been verified below.
          return safeResult(canonicalRoot, root, normalized);
        }
        throw error;
      }
      return safeResult(canonicalRoot, root, normalized);
    }
    if (info.isSymbolicLink()) {
      throw securityError(`Project path contains a symbolic link: ${segments.slice(0, index + 1).join('/')}`);
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw securityError(`Project path crosses a non-directory component: ${segments.slice(0, index + 1).join('/')}`);
    }
    const resolved = await realpath(current);
    assertContained(canonicalRoot, resolved, normalized);
    if (index === segments.length - 1 && requireFile && !info.isFile()) {
      throw securityError(`Project path is not a regular file: ${normalized}`);
    }
  }
  return safeResult(canonicalRoot, root, normalized);
}

export async function assertSafeAbsoluteProjectPath(projectRoot, absolutePath, options = {}) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(absolutePath);
  const relative = path.relative(root, target).split(path.sep).join('/');
  return assertSafeProjectPath(root, relative, options);
}

export function normalizeRelative(value) {
  const raw = String(value ?? '').replaceAll('\\', '/');
  if (!raw || raw.includes('\0') || path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw securityError(`Invalid project-relative path: ${raw || '<empty>'}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw securityError(`Project path escapes the project root: ${raw}`);
  }
  return normalized;
}

function safeResult(canonicalRoot, root, relative) {
  const target = path.resolve(root, ...relative.split('/'));
  const lexicalPrefix = `${root}${path.sep}`;
  if (target !== root && !target.startsWith(lexicalPrefix)) {
    throw securityError(`Project path escapes the project root: ${relative}`);
  }
  return { root, canonicalRoot, relative, target };
}

function assertContained(root, target, relative) {
  const prefix = `${root}${path.sep}`;
  if (target !== root && !target.startsWith(prefix)) {
    throw securityError(`Project path resolves outside the project through a link: ${relative}`);
  }
}

function securityError(message) {
  const error = new Error(message);
  error.code = 'unsafe_path';
  return error;
}
