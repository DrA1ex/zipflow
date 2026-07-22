const PROJECT_MARKERS = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'CMakeLists.txt',
  'go.mod', 'go.work', 'Package.swift', 'Cargo.toml',
]);
const GENERIC_SINGLE_FILES = new Set(['README', 'README.md', 'LICENSE', 'LICENSE.md', 'CHANGELOG.md']);

export function scoreArchiveMatch(projectPaths, archivePaths) {
  const projectSet = new Set(normalizePaths(projectPaths));
  const raw = normalizePaths(archivePaths);
  const variants = [{ paths: raw, wrapper: null }];
  const wrapper = commonWrapper(raw);
  if (wrapper) variants.push({ paths: raw.map((value) => value.slice(wrapper.length + 1)), wrapper });
  let best = emptyMatch();
  for (const variant of variants) {
    const exactPaths = variant.paths.filter((value) => projectSet.has(value));
    const markerPaths = exactPaths.filter(isProjectMarker);
    const specificPaths = exactPaths.filter((value) => value.includes('/') || !GENERIC_SINGLE_FILES.has(value));
    const archiveCoverage = exactPaths.length / Math.max(1, variant.paths.length);
    const projectCoverage = exactPaths.length / Math.max(1, projectSet.size);
    const suitable = markerPaths.length > 0
      || exactPaths.length >= 3
      || (specificPaths.length >= 1 && archiveCoverage >= 0.5);
    const score = markerPaths.length * 80 + exactPaths.length * 8
      + Math.round(archiveCoverage * 40) + Math.round(projectCoverage * 20)
      - Math.min(20, Math.max(0, variant.paths.length - exactPaths.length));
    if (score > best.score) {
      best = {
        suitable, score, wrapper: variant.wrapper, exactPaths,
        exactCount: exactPaths.length, markerCount: markerPaths.length,
        archiveCoverage, projectCoverage,
      };
    }
  }
  return best;
}

function normalizePaths(paths) {
  return [...new Set((paths ?? []).map((value) => String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean))];
}

function commonWrapper(paths) {
  if (!paths.length || paths.some((value) => !value.includes('/'))) return null;
  const roots = new Set(paths.map((value) => value.split('/')[0]));
  return roots.size === 1 ? [...roots][0] : null;
}

function isProjectMarker(value) {
  return PROJECT_MARKERS.has(value)
    || /^[^/]+\.xcodeproj\/project\.pbxproj$/i.test(value)
    || /^[^/]+\.xcworkspace\/contents\.xcworkspacedata$/i.test(value);
}

function emptyMatch() {
  return {
    suitable: false, score: Number.NEGATIVE_INFINITY, wrapper: null, exactPaths: [],
    exactCount: 0, markerCount: 0, archiveCoverage: 0, projectCoverage: 0,
  };
}
