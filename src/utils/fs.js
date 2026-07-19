import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureDir(target) {
  await mkdir(target, { recursive: true });
  return target;
}

export async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(target, value) {
  await ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

export async function writeTextAtomic(target, value) {
  await ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, 'utf8');
  await rename(temporary, target);
}

export async function walkFiles(root, { include = () => true, descend = () => true } = {}) {
  const files = [];
  async function visit(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (descend(relative)) await visit(absolute, relative);
      } else if (entry.isFile() && include(relative)) {
        files.push(relative);
      }
    }
  }
  await visit(root);
  files.sort();
  return files;
}

export async function removeIfExists(target) {
  await rm(target, { recursive: true, force: true });
}
