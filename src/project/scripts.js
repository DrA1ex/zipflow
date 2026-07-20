import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { exists } from '../utils/fs.js';

const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.rb', '.pl']);
const CHECK_PATTERN = /(^|[-_.])(test|tests|check|verify|validate|lint|format|typecheck|type-check|build|smoke|e2e|integration|unit)([-_.]|$)/i;
const DEPLOY_PATTERN = /(^|[-_.])(deploy|release|publish|upload|ship|distribute|distribution|notarize|package|archive|sync|install)([-_.]|$)/i;

export async function discoverProjectScripts(root, { limit = 200 } = {}) {
  const scriptsRoot = path.join(root, 'scripts');
  if (!(await exists(scriptsRoot))) return [];
  const files = await listScripts(scriptsRoot, scriptsRoot, limit);
  const candidates = [];
  for (const relative of files) {
    const projectRelative = normalize(path.join('scripts', relative));
    const absolute = path.join(root, projectRelative);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) continue;
    const commandText = commandFor(projectRelative, Boolean(info.mode & 0o111));
    if (!commandText) continue;
    const base = path.basename(relative, path.extname(relative));
    const deployment = DEPLOY_PATTERN.test(relative);
    const checkLike = CHECK_PATTERN.test(relative);
    candidates.push({
      id: `script:${projectRelative}`,
      name: titleFromName(base),
      path: projectRelative,
      commandText,
      cwd: '.',
      source: './scripts',
      deployment,
      checkLike,
      type: classifyCheckType(relative),
    });
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

export function scriptCheckCandidates(scripts) {
  return scripts.filter((item) => !item.deployment).map((item) => ({
    id: item.id,
    name: item.name,
    description: item.commandText,
    kind: 'custom',
    type: item.type,
    commandText: item.commandText,
    cwd: item.cwd,
    selected: item.checkLike,
    required: true,
    timeoutMs: item.type === 'integration' ? 1_800_000 : 900_000,
    discovered: true,
    source: item.source,
  }));
}

export function scriptDeployCandidates(scripts) {
  const preferred = scripts.filter((item) => item.deployment);
  const others = scripts.filter((item) => !item.deployment);
  return [...preferred, ...others].map((item) => ({
    id: `deploy:${item.id}`,
    name: item.name,
    description: `${item.commandText}${item.deployment ? ' · deploy-like script' : ' · project script'}`,
    commandText: item.commandText,
    cwd: item.cwd,
    preferred: item.deployment,
    source: item.source,
  }));
}

async function listScripts(root, current, limit, result = []) {
  if (result.length >= limit) return result;
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (result.length >= limit) break;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await listScripts(root, absolute, limit, result);
    else if (entry.isFile()) result.push(normalize(path.relative(root, absolute)));
  }
  return result;
}

function commandFor(relative, executable) {
  const extension = path.extname(relative).toLowerCase();
  const quoted = shellQuote(relative);
  if (executable) return `./${relative}`;
  if (['.sh', '.bash'].includes(extension)) return `bash ${quoted}`;
  if (extension === '.zsh') return `zsh ${quoted}`;
  if (extension === '.py') return `python3 ${quoted}`;
  if (['.js', '.mjs', '.cjs'].includes(extension)) return `node ${quoted}`;
  if (extension === '.rb') return `ruby ${quoted}`;
  if (extension === '.pl') return `perl ${quoted}`;
  if (!extension && SCRIPT_EXTENSIONS.has(extension)) return `./${relative}`;
  return null;
}

function classifyCheckType(value) {
  if (/e2e|integration|smoke|acceptance|system/i.test(value)) return 'integration';
  if (/lint|format/i.test(value)) return 'lint';
  if (/build|package|archive/i.test(value)) return 'build';
  if (/type.?check/i.test(value)) return 'typecheck';
  if (/test|unit/i.test(value)) return 'test';
  return 'custom';
}

function titleFromName(value) {
  return value.split(/[-_.]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') || 'Project script';
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function normalize(value) {
  return value.split(path.sep).join('/');
}
