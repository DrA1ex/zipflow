import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { exists } from '../utils/fs.js';
import { canonicalPath } from '../utils/paths.js';
import { findGitRoot } from '../git/root.js';
import { assertSafeProjectPath, normalizeRelative } from '../security/project-path.js';
import { detectNodeProject } from './detectors/node.js';
import { detectPythonProject } from './detectors/python.js';
import { detectCmakeProject } from './detectors/cmake.js';
import { detectGoProject } from './detectors/go.js';
import { detectSwiftProject } from './detectors/swift.js';
import { discoverProjectScripts, scriptCheckCandidates, scriptDeployCandidates } from './scripts.js';

const ROOT_MARKERS = ['package.json', 'pyproject.toml', 'requirements.txt', 'CMakeLists.txt', 'go.mod', 'go.work', 'Package.swift'];
const DETECTORS = [detectNodeProject, detectPythonProject, detectCmakeProject, detectGoProject, detectSwiftProject];

export const AUTO_PROJECT_SCAN_EXCLUDES = new Set([
  '.git', '.github', '.gitlab', '.idea', '.vscode', '.zipflow',
  '.cache', '.next', '.nuxt', '.output', '.turbo',
  '.gradle', '.tox', '.nox',
  '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'node_modules', 'bower_components', 'vendor', 'vendors', 'packages-cache',
  'Pods',
  'build', 'dist', 'out', 'target', 'coverage',
  'lib', 'libs', 'library', 'libraries',
]);

export async function discoverProject(startPath = process.cwd()) {
  const start = await canonicalPath(startPath);
  const gitRoot = await findGitRoot(start);
  const markerRoot = await findNearestMarkerRoot(start);
  const root = gitRoot ?? markerRoot ?? start;
  const rootEntry = await inspectProjectDirectory(root, '.', { source: 'detected', includeUnknown: true });
  const { projects: childProjects, ignoredDirectories } = await discoverChildProjects(root);
  const projects = [rootEntry, ...childProjects].map((entry) => ({ ...entry, selected: true }));
  return aggregateWorkspaceProject({
    root,
    start,
    gitRoot,
    rootEntry,
    projects,
    ignoredDirectories,
  });
}

export async function discoverProjectEntry(workspaceRoot, relativePath, {
  source = 'manual',
  includeUnknown = true,
  manualType = null,
} = {}) {
  const root = await canonicalPath(workspaceRoot);
  const relative = normalizeWorkspaceRelative(relativePath);
  if (relative === '.') return inspectProjectDirectory(root, '.', { source, includeUnknown, manualType });
  const safe = await assertSafeProjectPath(root, relative, { allowMissingLeaf: false });
  const info = await stat(safe.target).catch(() => null);
  if (!info?.isDirectory()) {
    const error = new Error(`Project directory not found: ${relative}/`);
    error.code = 'missing_project_directory';
    throw error;
  }
  return inspectProjectDirectory(root, relative, { source, includeUnknown, manualType });
}

export async function configureWorkspaceProjects(project, configuredProjects = []) {
  if (!Array.isArray(configuredProjects) || !configuredProjects.length) return project;
  const existing = new Set((project.projects ?? []).map((entry) => entry.path));
  const additional = [];
  for (const configured of configuredProjects) {
    const relative = normalizeWorkspaceRelative(configured.path || '.');
    if (existing.has(relative)) continue;
    try {
      additional.push(await discoverProjectEntry(project.root, relative, {
        source: configured.source === 'detected' ? 'manual' : configured.source,
        includeUnknown: true,
        manualType: configured.typeIds?.[0] ?? null,
      }));
    } catch {
      additional.push({
        path: relative,
        root: null,
        source: configured.source ?? 'manual',
        manual: true,
        missing: true,
        detected: false,
        technologies: [],
        labels: configured.labels ?? [],
        checks: [],
        scripts: [],
        deployCandidates: [],
        notes: [],
        name: relative,
        markerFiles: [],
      });
    }
  }
  const merged = additional.length ? mergeManualProjects(project, additional) : project;
  const selectedPaths = configuredProjects
    .filter((entry) => entry.selected !== false)
    .map((entry) => entry.path || '.');
  return applyProjectSelection(merged, selectedPaths);
}

export function applyProjectSelection(project, selectedPaths) {
  const selected = new Set((selectedPaths ?? []).map(normalizeWorkspaceRelative));
  const projects = (project.projects ?? []).map((entry) => ({
    ...entry,
    selected: selected.has(entry.path),
  }));
  const rootEntry = projects.find((entry) => entry.path === '.') ?? project.rootEntry;
  return aggregateWorkspaceProject({
    root: project.root,
    start: project.start,
    gitRoot: project.gitRoot,
    rootEntry,
    projects,
    ignoredDirectories: project.ignoredDirectories ?? [],
  });
}

export function mergeManualProjects(project, manualProjects = []) {
  const entries = new Map((project.projects ?? []).map((entry) => [entry.path, entry]));
  for (const entry of manualProjects) entries.set(entry.path, { ...entry, source: 'manual' });
  const projects = [...entries.values()].sort(projectEntryOrder);
  const rootEntry = projects.find((entry) => entry.path === '.') ?? project.rootEntry;
  return aggregateWorkspaceProject({
    root: project.root,
    start: project.start,
    gitRoot: project.gitRoot,
    rootEntry,
    projects,
    ignoredDirectories: project.ignoredDirectories ?? [],
  });
}

export function normalizeWorkspaceRelative(value) {
  const raw = String(value ?? '').trim().replaceAll('\\', '/');
  if (!raw || raw === '.' || raw === './') return '.';
  return normalizeRelative(raw.replace(/^\.\//, '').replace(/\/+$/, ''));
}

async function discoverChildProjects(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const projects = [];
  const ignoredDirectories = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (AUTO_PROJECT_SCAN_EXCLUDES.has(entry.name)) {
      ignoredDirectories.push(entry.name);
      continue;
    }
    const inspected = await inspectProjectDirectory(root, entry.name, { source: 'detected', includeUnknown: false });
    if (inspected) projects.push(inspected);
  }
  return { projects, ignoredDirectories };
}

async function inspectProjectDirectory(workspaceRoot, relativePath, {
  source,
  includeUnknown,
  manualType = null,
}) {
  const projectRoot = relativePath === '.' ? workspaceRoot : path.join(workspaceRoot, ...relativePath.split('/'));
  const technologies = [];
  for (const detector of DETECTORS) {
    const detected = await detector(projectRoot);
    if (detected) technologies.push(detected);
  }
  if (!technologies.length && !includeUnknown && !manualType) return null;
  if (!technologies.length && manualType && manualType !== 'custom') technologies.push(manualTechnology(manualType));
  const scripts = await discoverProjectScripts(projectRoot);
  const checks = dedupeById([
    ...technologies.flatMap((item) => item.checks ?? []),
    ...scriptCheckCandidates(scripts),
  ]);
  const deployCandidates = dedupeByCommand([
    ...technologies.flatMap((item) => item.deployCandidates ?? []),
    ...scriptDeployCandidates(scripts),
  ]);
  return {
    path: relativePath,
    root: projectRoot,
    source,
    manual: source === 'manual',
    detected: technologies.length > 0,
    technologies,
    labels: technologies.map((item) => item.label),
    checks,
    scripts,
    deployCandidates,
    notes: technologies.map((item) => item.note).filter(Boolean),
    name: inferProjectName(projectRoot, technologies),
    markerFiles: unique(technologies.flatMap((item) => item.files ?? []).filter(Boolean)),
  };
}

function aggregateWorkspaceProject({ root, start, gitRoot, rootEntry, projects, ignoredDirectories }) {
  const activeProjects = projects.filter((entry) => entry.selected !== false);
  const checks = dedupeById(activeProjects.flatMap((entry) => entry.checks.map((check) => qualifyCheck(entry, check))));
  const deployCandidates = dedupeByCommand(activeProjects.flatMap((entry) => entry.deployCandidates.map((candidate) => qualifyDeploy(entry, candidate))));
  const scripts = activeProjects.flatMap((entry) => entry.scripts.map((script) => ({
    ...script,
    id: qualifyId(entry.path, script.id),
    cwd: combineCwd(entry.path, script.cwd),
    projectPath: entry.path,
  })));
  const workspaceTechnologies = uniqueById(activeProjects.flatMap((entry) => entry.technologies));
  const workspaceLabels = unique(workspaceTechnologies.map((item) => item.label));
  const notes = activeProjects.flatMap((entry) => entry.notes.map((note) => entry.path === '.' ? note : `${entry.path}/: ${note}`));
  return {
    root,
    start,
    git: Boolean(gitRoot),
    gitRoot,
    technologies: rootEntry?.technologies ?? [],
    labels: rootEntry?.labels ?? [],
    rootEntry,
    projects,
    activeProjects,
    workspaceTechnologies,
    workspaceLabels,
    ignoredDirectories,
    checks,
    scripts,
    deployCandidates,
    notes,
    name: rootEntry?.name || path.basename(root),
    multiProject: activeProjects.filter((entry) => entry.detected).length > 1,
  };
}

function qualifyCheck(entry, check) {
  return {
    ...check,
    id: qualifyId(entry.path, check.id),
    cwd: combineCwd(entry.path, check.cwd),
    projectPath: entry.path,
    projectLabel: projectLocationLabel(entry.path),
  };
}

function qualifyDeploy(entry, candidate) {
  return {
    ...candidate,
    id: qualifyId(entry.path, candidate.id),
    cwd: combineCwd(entry.path, candidate.cwd),
    projectPath: entry.path,
    projectLabel: projectLocationLabel(entry.path),
  };
}

function combineCwd(projectPath, commandCwd = '.') {
  const left = normalizeWorkspaceRelative(projectPath);
  const right = normalizeWorkspaceRelative(commandCwd);
  if (left === '.') return right;
  if (right === '.') return left;
  return path.posix.join(left, right);
}

function qualifyId(projectPath, id) {
  return projectPath === '.' ? id : `${projectPath}:${id}`;
}

function projectLocationLabel(projectPath) {
  return projectPath === '.' ? 'Root' : `${projectPath}/`;
}

async function findNearestMarkerRoot(start) {
  let current = start;
  while (true) {
    if (await hasProjectMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function inferProjectName(root, technologies) {
  const node = technologies.find((item) => item.id === 'node');
  return node?.details?.packageName || path.basename(root);
}

async function hasProjectMarker(root) {
  for (const marker of ROOT_MARKERS) if (await exists(path.join(root, marker))) return true;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isDirectory() && (entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace')));
}

function manualTechnology(id) {
  const labels = {
    node: 'Node.js', python: 'Python', cmake: 'CMake · C/C++', go: 'Go', swift: 'Swift', custom: 'Custom project',
  };
  return { id, label: labels[id] ?? 'Custom project', details: { manual: true }, files: [], checks: [], deployCandidates: [] };
}

function dedupeById(values) {
  const seen = new Set();
  return values.filter((value) => value?.id && !seen.has(value.id) && seen.add(value.id));
}

function dedupeByCommand(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = `${value?.cwd ?? '.'}:${value?.commandText ?? ''}`;
    if (!value?.commandText || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueById(values) {
  const seen = new Set();
  return values.filter((value) => value?.id && !seen.has(value.id) && seen.add(value.id));
}

function projectEntryOrder(left, right) {
  if (left.path === '.') return -1;
  if (right.path === '.') return 1;
  return left.path.localeCompare(right.path);
}
