import path from 'node:path';
import { exists } from '../utils/fs.js';
import { canonicalPath } from '../utils/paths.js';
import { findGitRoot } from '../git/repository.js';
import { detectNodeProject } from './detectors/node.js';
import { detectPythonProject } from './detectors/python.js';
import { detectCmakeProject } from './detectors/cmake.js';
import { detectGoProject } from './detectors/go.js';
import { detectSwiftProject } from './detectors/swift.js';
import { discoverProjectScripts, scriptCheckCandidates, scriptDeployCandidates } from './scripts.js';

const ROOT_MARKERS = ['package.json', 'pyproject.toml', 'requirements.txt', 'CMakeLists.txt', 'go.mod', 'go.work', 'Package.swift'];
const DETECTORS = [detectNodeProject, detectPythonProject, detectCmakeProject, detectGoProject, detectSwiftProject];

export async function discoverProject(startPath = process.cwd()) {
  const start = await canonicalPath(startPath);
  const gitRoot = await findGitRoot(start);
  const markerRoot = await findNearestMarkerRoot(start);
  const root = gitRoot ?? markerRoot ?? start;
  const technologies = [];
  for (const detector of DETECTORS) {
    const detected = await detector(root);
    if (detected) technologies.push(detected);
  }
  const scripts = await discoverProjectScripts(root);
  const checks = dedupeById([
    ...technologies.flatMap((item) => item.checks ?? []),
    ...scriptCheckCandidates(scripts),
  ]);
  const deployCandidates = dedupeByCommand([
    ...technologies.flatMap((item) => item.deployCandidates ?? []),
    ...scriptDeployCandidates(scripts),
  ]);
  return {
    root,
    start,
    git: Boolean(gitRoot),
    gitRoot,
    technologies,
    labels: technologies.map((item) => item.label),
    checks,
    scripts,
    deployCandidates,
    notes: technologies.map((item) => item.note).filter(Boolean),
    name: inferProjectName(root, technologies),
  };
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
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isDirectory() && (entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace')));
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
