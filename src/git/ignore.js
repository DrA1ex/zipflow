import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import createIgnore from 'ignore';
import { exists } from '../utils/fs.js';

const COMMON_GROUPS = [
  {
    title: 'Zipflow and local environment',
    patterns: ['.zipflow/', '.env', '.env.*', '!.env.example', '*.log'],
  },
  {
    title: 'Operating system metadata',
    patterns: ['.DS_Store', '._*', 'Thumbs.db', 'Desktop.ini'],
  },
  {
    title: 'Editors and IDEs',
    patterns: ['.idea/', '.vscode/', '*.swp', '*.swo', '*~'],
  },
  {
    title: 'Temporary files',
    patterns: ['*.tmp', '*.temp', '.cache/'],
  },
];

const TECHNOLOGY_GROUPS = {
  node: {
    title: 'Node.js',
    patterns: ['node_modules/', '.npm/', '.pnpm-store/', '.yarn/cache/', 'coverage/', 'dist/', 'build/'],
  },
  typescript: {
    title: 'TypeScript',
    patterns: ['*.tsbuildinfo'],
  },
  python: {
    title: 'Python',
    patterns: ['__pycache__/', '*.py[cod]', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.venv/', 'venv/', 'dist/', 'build/', '*.egg-info/'],
  },
  cmake: {
    title: 'CMake and C++',
    patterns: ['build/', 'cmake-build-*/', 'CMakeFiles/', 'CMakeCache.txt', 'compile_commands.json'],
  },
  go: {
    title: 'Go',
    patterns: ['bin/', '*.test', 'coverage.out'],
  },
};

export function recommendedGitignoreGroups(project) {
  const groups = [...COMMON_GROUPS];
  const ids = new Set(project.technologies?.map((item) => item.id) ?? []);
  if (ids.has('node')) groups.push(TECHNOLOGY_GROUPS.node);
  if (ids.has('node') && project.labels?.some((label) => /typescript/i.test(label))) groups.push(TECHNOLOGY_GROUPS.typescript);
  if (ids.has('python')) groups.push(TECHNOLOGY_GROUPS.python);
  if (ids.has('cmake')) groups.push(TECHNOLOGY_GROUPS.cmake);
  if (ids.has('go')) groups.push(TECHNOLOGY_GROUPS.go);
  return groups.map((group) => ({ ...group, patterns: [...group.patterns] }));
}

export function renderRecommendedGitignore(project) {
  return recommendedGitignoreGroups(project)
    .map((group) => [`# ${group.title}`, ...group.patterns].join('\n'))
    .join('\n\n') + '\n';
}

export async function addRecommendedGitignore(project) {
  const target = path.join(project.root, '.gitignore');
  if (await exists(target)) {
    return { path: target, created: false, changed: false, existing: true, addedCount: 0 };
  }
  const content = renderRecommendedGitignore(project);
  try {
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      return { path: target, created: false, changed: false, existing: true, addedCount: 0 };
    }
    throw error;
  }
  const addedCount = recommendedGitignoreGroups(project)
    .reduce((total, group) => total + group.patterns.length, 0);
  return { path: target, created: true, changed: true, existing: false, addedCount };
}

export async function createRootGitignoreMatcher(projectRoot) {
  const target = path.join(projectRoot, '.gitignore');
  if (!(await exists(target))) return () => false;
  const matcher = createIgnore();
  matcher.add(await readFile(target, 'utf8'));
  return (relativePath) => matcher.ignores(normalize(relativePath));
}

function normalize(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}
