import path from 'node:path';
import { canonicalPath } from '../utils/paths.js';
import { loadWorkflow, saveWorkflow } from '../workflow/store.js';
import { normalizeWorkflow, WORKFLOW_VERSION } from '../workflow/defaults.js';
import {
  ensurePrivateStorageRoot,
  KeyedSerialQueue,
  readJsonStrict,
  requestFingerprint,
} from '../server/store-utils.js';
import { writeJsonDurableAtomic } from '../utils/fs.js';

export class WorkflowResourceStore {
  constructor({ root, now = () => new Date() } = {}) {
    if (!root) throw new TypeError('Workflow resource metadata root is required.');
    this.root = path.resolve(root);
    this.now = now;
    this.queue = new KeyedSerialQueue();
    this.initialized = false;
  }

  async initialize() {
    await ensurePrivateStorageRoot(this.root);
    this.initialized = true;
    return this;
  }

  async get(project) {
    const identity = validateProject(project);
    await this.ensureInitialized();
    return this.queue.run(identity.projectId, () => this.loadUnlocked(identity));
  }

  async replace({ project, draft, expectedRevision }) {
    const identity = validateProject(project);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw workflowError('Workflow revision is invalid.', 'STALE_REVISION', 409);
    }
    await this.ensureInitialized();
    return this.queue.run(identity.projectId, async () => {
      const current = await this.loadUnlocked(identity);
      if (current.revision !== expectedRevision) {
        throw workflowError(
          'The workflow changed after it was read.',
          'STALE_REVISION',
          409,
          { currentRevision: current.revision },
        );
      }
      const workflow = await normalizeDraft(draft, identity, current.workflow, this.now);
      const persisted = await saveWorkflow(workflow);
      const revision = current.revision + 1;
      await this.writeMetadata(identity.projectId, {
        version: 1,
        projectId: identity.projectId,
        canonicalPath: identity.canonicalPath,
        revision,
        workflowHash: requestFingerprint(persisted),
        updatedAt: this.now().toISOString(),
      });
      return resource(revision, persisted);
    });
  }

  async loadUnlocked(project) {
    const workflow = await loadWorkflow(project.canonicalPath);
    const stored = await readJsonStrict(this.metadataPath(project.projectId), null);
    const metadata = stored ? validateMetadata(stored, project) : null;
    if (!workflow) {
      if (!metadata) return resource(0, null);
      if (metadata.workflowHash !== null) {
        throw workflowError('Workflow metadata does not match project storage.', 'SERVER_STORAGE_CORRUPT', 500);
      }
      return resource(metadata.revision, null);
    }

    const workflowHash = requestFingerprint(workflow);
    if (metadata?.workflowHash === workflowHash) return resource(metadata.revision, workflow);

    const revision = (metadata?.revision ?? 0) + 1;
    await this.writeMetadata(project.projectId, {
      version: 1,
      projectId: project.projectId,
      canonicalPath: project.canonicalPath,
      revision,
      workflowHash,
      updatedAt: this.now().toISOString(),
    });
    return resource(revision, workflow);
  }

  async writeMetadata(projectId, value) {
    await writeJsonDurableAtomic(this.metadataPath(projectId), value);
  }

  metadataPath(projectId) {
    return path.join(this.root, `${projectId}.json`);
  }

  async ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }
}

export function workflowEtag(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('Workflow revision must be a non-negative safe integer.');
  }
  return `"${revision}"`;
}

export function parseRevisionEtag(value) {
  const match = /^"(0|[1-9]\d*)"$/.exec(String(value ?? ''));
  if (!match) throw workflowError('If-Match must contain one quoted workflow revision.', 'STALE_REVISION', 409);
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) {
    throw workflowError('If-Match workflow revision is too large.', 'STALE_REVISION', 409);
  }
  return revision;
}

export function workflowSemanticFingerprint(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new TypeError('A workflow object is required.');
  }
  const normalized = normalizeWorkflow(structuredClone(workflow));
  delete normalized.createdAt;
  delete normalized.updatedAt;
  return requestFingerprint(normalized);
}

async function normalizeDraft(draft, project, current, now) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw workflowError('A complete workflow object is required.', 'ACTION_INPUT_INVALID', 400);
  }
  if (draft.version !== undefined && draft.version !== WORKFLOW_VERSION) {
    throw workflowError('Workflow format version is not supported.', 'ACTION_INPUT_INVALID', 400);
  }
  if (draft.projectPath !== undefined) {
    const requested = await canonicalPath(draft.projectPath).catch(() => null);
    if (requested !== project.canonicalPath) {
      throw workflowError('Workflow project path does not match the opened project.', 'ACTION_INPUT_INVALID', 400);
    }
  }
  const timestamp = now().toISOString();
  const candidate = normalizeWorkflow({
    ...structuredClone(draft),
    version: WORKFLOW_VERSION,
    projectPath: project.canonicalPath,
    createdAt: current?.createdAt ?? draft.createdAt ?? timestamp,
    updatedAt: timestamp,
  });
  if (typeof candidate.name !== 'string' || !candidate.name.trim() || !Array.isArray(candidate.checks)) {
    throw workflowError('Workflow is missing required fields.', 'ACTION_INPUT_INVALID', 400);
  }
  return candidate;
}

function validateProject(project) {
  if (
    !project
    || typeof project.projectId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(project.projectId)
    || typeof project.canonicalPath !== 'string'
    || !path.isAbsolute(project.canonicalPath)
  ) {
    throw new TypeError('A valid opened project is required.');
  }
  return {
    projectId: project.projectId,
    canonicalPath: path.resolve(project.canonicalPath),
  };
}

function validateMetadata(value, project) {
  if (
    value?.version !== 1
    || value.projectId !== project.projectId
    || path.resolve(value.canonicalPath ?? '') !== project.canonicalPath
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || (value.workflowHash !== null && !/^[a-f0-9]{64}$/.test(value.workflowHash))
    || !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw workflowError('Workflow revision metadata is corrupt.', 'SERVER_STORAGE_CORRUPT', 500);
  }
  return value;
}

function resource(revision, workflow) {
  return {
    revision,
    workflow: workflow ? structuredClone(workflow) : null,
  };
}

function workflowError(message, code, status, details = {}) {
  return Object.assign(new Error(message), {
    code,
    status,
    expose: status < 500,
    detail: message,
    details,
  });
}
