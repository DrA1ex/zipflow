import os from 'node:os';
import path from 'node:path';
import { hashText } from '../utils/hash.js';
import { chmod, mkdir } from 'node:fs/promises';
import { readJson, writeJsonAtomic } from '../utils/fs.js';
import { canonicalPath } from '../utils/paths.js';
import { normalizeWorkflow, WORKFLOW_VERSION } from './defaults.js';

export function getZipflowHome() {
  if (process.env.ZIPFLOW_HOME) return path.resolve(process.env.ZIPFLOW_HOME);
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `zipflow-test-home-${process.pid}`);
  return path.join(os.homedir(), '.zipflow');
}

export async function ensureZipflowHome() {
  const home = getZipflowHome();
  const directories = [
    home,
    path.join(home, 'workflows'),
    path.join(home, 'runs'),
    path.join(home, 'backups'),
    path.join(home, 'tmp'),
    path.join(home, 'locks'),
    path.join(home, 'projects'),
    path.join(home, 'languages'),
  ];
  await Promise.all(directories.map(async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }));
  return home;
}

export async function workflowPathForProject(projectPath) {
  const canonical = await canonicalPath(projectPath);
  return path.join(getZipflowHome(), 'workflows', `${hashText(canonical).slice(0, 24)}.json`);
}

export async function loadWorkflow(projectPath) {
  await ensureZipflowHome();
  const target = await workflowPathForProject(projectPath);
  const workflow = await readJson(target, null);
  if (!workflow) return null;
  validateWorkflow(workflow);
  return normalizeWorkflow(workflow);
}

export async function saveWorkflow(workflow) {
  await ensureZipflowHome();
  const target = await workflowPathForProject(workflow.projectPath);
  const value = normalizeWorkflow({ ...workflow, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(target, value);
  return value;
}

export function validateWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object') throw new Error('Workflow file is invalid.');
  if (!Number.isInteger(workflow.version) || workflow.version < 1 || workflow.version > WORKFLOW_VERSION) {
    throw new Error(`Unsupported workflow version: ${workflow.version}`);
  }
  if (!workflow.projectPath || !Array.isArray(workflow.checks)) throw new Error('Workflow is missing required fields.');
  return workflow;
}
