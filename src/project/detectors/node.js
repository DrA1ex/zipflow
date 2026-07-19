import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { exists, readJson } from '../../utils/fs.js';

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

export async function detectNodeProject(root) {
  const packageFile = path.join(root, 'package.json');
  if (!(await exists(packageFile))) return null;
  let packageJson = {};
  let parseError = null;
  try {
    packageJson = await readJson(packageFile, {});
  } catch (error) {
    parseError = error.message;
  }
  const packageManager = await detectPackageManager(root, packageJson.packageManager);
  const scripts = packageJson.scripts ?? {};
  const typescript = await exists(path.join(root, 'tsconfig.json'));
  const checks = [];
  checks.push({
    id: 'node-syntax',
    name: 'JavaScript syntax',
    description: 'Checks changed .js, .mjs and .cjs files',
    kind: 'node-syntax',
    type: 'syntax',
    selected: true,
    required: true,
    timeoutMs: 120_000,
  });
  for (const [name, command] of Object.entries(scripts)) {
    const classification = classifyScript(name, command);
    if (!classification) continue;
    checks.push({
      id: `node-script:${name}`,
      name: classification.title,
      description: `${packageManager} run ${name}`,
      kind: 'command',
      type: classification.type,
      command: packageManager === 'npm' && name === 'test' ? ['npm', 'test'] : [packageManager, 'run', name],
      selected: classification.selected,
      required: true,
      timeoutMs: classification.timeoutMs,
    });
  }
  if (typescript && !checks.some((check) => check.type === 'typecheck')) {
    const localTsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    if (await exists(localTsc)) {
      checks.push({
        id: 'typescript-noemit',
        name: 'TypeScript',
        description: 'tsc --noEmit',
        kind: 'command',
        type: 'typecheck',
        command: [localTsc, '--noEmit'],
        selected: true,
        required: true,
        timeoutMs: 300_000,
      });
    }
  }
  return {
    id: 'node',
    label: typescript ? 'Node.js · TypeScript' : 'Node.js',
    details: { packageManager, typescript, packageName: packageJson.name ?? path.basename(root), parseError },
    files: ['package.json', ...LOCKFILES.map(([file]) => file), ...(typescript ? ['tsconfig.json'] : [])],
    checks: dedupeChecks(checks),
    note: parseError ? `package.json could not be parsed: ${parseError}` : null,
  };
}

async function detectPackageManager(root, declared) {
  const declaredName = String(declared ?? '').split('@')[0];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declaredName)) return declaredName;
  for (const [file, manager] of LOCKFILES) {
    if (await exists(path.join(root, file))) return manager;
  }
  return 'npm';
}

function classifyScript(name, command) {
  const value = `${name} ${command}`.toLowerCase();
  if (/publish|deploy|release|install|prepare|postinstall|preinstall/.test(name.toLowerCase())) return null;
  if (/type.?check|tsc/.test(value)) return { title: titleFromName(name), type: 'typecheck', selected: true, timeoutMs: 300_000 };
  if (/lint/.test(name)) return { title: titleFromName(name), type: 'lint', selected: !/fix/.test(name), timeoutMs: 300_000 };
  if (/test/.test(name)) {
    const long = /e2e|integration|smoke|system|acceptance/.test(name);
    return { title: titleFromName(name), type: long ? 'integration' : 'test', selected: !long && name === 'test', timeoutMs: long ? 1_800_000 : 900_000 };
  }
  if (/build/.test(name)) return { title: titleFromName(name), type: 'build', selected: false, timeoutMs: 900_000 };
  if (/^check$|check:/.test(name)) return { title: titleFromName(name), type: 'check', selected: name === 'check', timeoutMs: 600_000 };
  return null;
}

function titleFromName(name) {
  return name.split(/[:_-]/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ');
}

function dedupeChecks(checks) {
  const seenTypes = new Set();
  return checks.filter((check) => {
    const key = check.id;
    if (seenTypes.has(key)) return false;
    seenTypes.add(key);
    return true;
  });
}
