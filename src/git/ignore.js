import path from 'node:path';
import { readFile } from 'node:fs/promises';
import createIgnore from 'ignore';
import { exists, writeTextAtomic } from '../utils/fs.js';

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
  const hadFile = await exists(target);
  const previous = await readOptionalText(target);
  const existingPatterns = existingPatternSet(previous);
  const sections = [];
  let addedCount = 0;
  for (const group of recommendedGitignoreGroups(project)) {
    const missing = group.patterns.filter((pattern) => !existingPatterns.has(pattern));
    if (!missing.length) continue;
    sections.push(`# ${group.title}`, ...missing, '');
    addedCount += missing.length;
  }
  if (!addedCount) return { path: target, created: false, changed: false, addedCount: 0 };
  const recommendations = sections.join('\n').replace(/\n+$/, '\n');
  const separator = previous ? '\n' : '';
  const next = `${recommendations}${separator}${previous}`;
  await writeTextAtomic(target, next);
  return { path: target, created: !hadFile, changed: true, addedCount };
}

export async function createRootGitignoreMatcher(projectRoot) {
  const target = path.join(projectRoot, '.gitignore');
  if (!(await exists(target))) return () => false;
  const matcher = createIgnore();
  matcher.add(await readFile(target, 'utf8'));
  return (relativePath) => matcher.ignores(normalize(relativePath));
}

async function readOptionalText(target) {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function existingPatternSet(content) {
  return new Set(String(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')));
}

function normalize(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}
