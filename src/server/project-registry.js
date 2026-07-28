import path from 'node:path';
import { hashText } from '../utils/hash.js';
import { canonicalPath } from '../utils/paths.js';
import { writeJsonDurableAtomic } from '../utils/fs.js';
import {
  ensurePrivateStorageRoot,
  KeyedSerialQueue,
  readJsonStrict,
} from './store-utils.js';

export class ProjectRegistry {
  constructor({
    root,
    now = () => new Date(),
    canonicalize = canonicalPath,
  } = {}) {
    if (!root) throw new TypeError('Project registry root is required.');
    this.root = path.resolve(root);
    this.registryPath = path.join(this.root, 'registry.json');
    this.now = now;
    this.canonicalize = canonicalize;
    this.queue = new KeyedSerialQueue();
    this.state = null;
  }

  async initialize() {
    await ensurePrivateStorageRoot(this.root);
    const stored = await readJsonStrict(this.registryPath, null);
    this.state = stored ? validateRegistry(stored) : emptyRegistry();
    return this;
  }

  async open(projectPath, project = {}) {
    return this.queue.run('registry', async () => {
      await this.ensureInitialized();
      let canonical;
      try {
        canonical = await this.canonicalize(projectPath);
      } catch (error) {
        throw Object.assign(new Error('Project path could not be canonicalized.', { cause: error }), {
          code: 'PROJECT_PATH_INVALID',
        });
      }
      const existing = this.state.projects.find((entry) => entry.canonicalPath === canonical);
      if (existing) return clone(existing);

      const timestamp = this.now().toISOString();
      const record = {
        projectId: projectIdForCanonicalPath(canonical),
        canonicalPath: canonical,
        project: {
          name: cleanName(project.name, path.basename(canonical)),
          technologies: cleanStrings(project.technologies),
          labels: cleanStrings(project.labels),
        },
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 1,
      };
      this.state = {
        ...this.state,
        revision: this.state.revision + 1,
        projects: [...this.state.projects, record],
      };
      await this.persist();
      return clone(record);
    });
  }

  async get(projectId) {
    await this.ensureInitialized();
    const record = this.state.projects.find((entry) => entry.projectId === projectId);
    return record ? clone(record) : null;
  }

  async findByPath(projectPath) {
    await this.ensureInitialized();
    const canonical = await this.canonicalize(projectPath);
    const record = this.state.projects.find((entry) => entry.canonicalPath === canonical);
    return record ? clone(record) : null;
  }

  async list() {
    await this.ensureInitialized();
    return this.state.projects.map(clone);
  }

  async ensureInitialized() {
    if (!this.state) await this.initialize();
  }

  async persist() {
    await writeJsonDurableAtomic(this.registryPath, this.state);
  }
}

export function projectIdForCanonicalPath(canonical) {
  return `project_${hashText(canonical).slice(0, 32)}`;
}

function emptyRegistry() {
  return { version: 1, revision: 0, projects: [] };
}

function validateRegistry(value) {
  if (value?.version !== 1 || !Number.isInteger(value.revision) || !Array.isArray(value.projects)) {
    throw corruptRegistry();
  }
  const paths = new Set();
  const ids = new Set();
  for (const project of value.projects) {
    if (
      typeof project?.projectId !== 'string'
      || !path.isAbsolute(project.canonicalPath)
      || ids.has(project.projectId)
      || paths.has(project.canonicalPath)
    ) {
      throw corruptRegistry();
    }
    ids.add(project.projectId);
    paths.add(project.canonicalPath);
  }
  return clone(value);
}

function cleanStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

function cleanName(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : '';
  return (name || fallback).slice(0, 255);
}

function clone(value) {
  return structuredClone(value);
}

function corruptRegistry() {
  return Object.assign(new Error('Project registry is corrupt.'), { code: 'SERVER_STORAGE_CORRUPT' });
}
