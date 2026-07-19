import path from 'node:path';
import { exists } from '../utils/fs.js';
import { canonicalPath } from '../utils/paths.js';
import { findGitRoot } from '../git/repository.js';
import { detectNodeProject } from './detectors/node.js';
import { detectPythonProject } from './detectors/python.js';
import { detectCmakeProject } from './detectors/cmake.js';
import { detectGoProject } from './detectors/go.js';

const ROOT_MARKERS = ['package.json', 'pyproject.toml', 'requirements.txt', 'CMakeLists.txt', 'go.mod', 'go.work'];
const DETECTORS = [detectNodeProject, detectPythonProject, detectCmakeProject, detectGoProject];

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
  return {
    root,
    start,
    git: Boolean(gitRoot),
    gitRoot,
    technologies,
    labels: technologies.map((item) => item.label),
    checks: technologies.flatMap((item) => item.checks ?? []),
    notes: technologies.map((item) => item.note).filter(Boolean),
    name: inferProjectName(root, technologies),
  };
}

async function findNearestMarkerRoot(start) {
  let current = start;
  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (await exists(path.join(current, marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function inferProjectName(root, technologies) {
  const node = technologies.find((item) => item.id === 'node');
  return node?.details?.packageName || path.basename(root);
}
