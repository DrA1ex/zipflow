import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  applyProjectSelection, configureWorkspaceProjects, discoverProject, discoverProjectEntry,
} from '../src/project/detect.js';
import {
  formatCommandSpec, parseCommandSpec, validateCommandSpec,
} from '../src/project/command-spec.js';
import { runChecks } from '../src/checks/runner.js';
import { runDeploy } from '../src/deploy/runner.js';
import { createRecommendedWorkflow, normalizeWorkflow, WORKFLOW_VERSION } from '../src/workflow/defaults.js';

async function fixture(prefix = 'zipflow-multiproject-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

test('detects root and one-level subprojects while skipping dependency and library directories', async () => {
  const { root, cleanup } = await fixture();
  try {
    await write(root, 'pyproject.toml', '[project]\nname="workspace"\n');
    await write(root, 'web/package.json', JSON.stringify({ name: 'web', scripts: { test: 'node --test', deploy: 'echo deploy' } }));
    await write(root, 'node_modules/ignored/package.json', '{"name":"ignored"}');
    await write(root, '.venv/ignored/package.json', '{"name":"ignored"}');
    await write(root, 'lib/package.json', '{"name":"ignored-lib"}');
    await write(root, 'packages/client/package.json', '{"name":"deep-client"}');

    const project = await discoverProject(root);

    assert.deepEqual(project.projects.map((entry) => entry.path), ['.', 'web']);
    assert.deepEqual(project.projects.map((entry) => entry.labels[0]), ['Python', 'Node.js']);
    assert.ok(project.checks.some((check) => check.id === 'web:node-script:test' && check.cwd === 'web'));
    assert.ok(project.deployCandidates.some((candidate) => candidate.commandText === 'npm run deploy' && candidate.cwd === 'web'));
    assert.deepEqual(project.ignoredDirectories.sort(), ['.venv', 'lib', 'node_modules']);
  } finally {
    await cleanup();
  }
});

test('manual project paths may be deeper than the automatic scan depth', async () => {
  const { root, cleanup } = await fixture();
  try {
    await write(root, 'package.json', '{"name":"root"}');
    await write(root, 'packages/client/package.json', JSON.stringify({ name: 'client', scripts: { lint: 'eslint .' } }));

    const project = await discoverProject(root);
    assert.equal(project.projects.some((entry) => entry.path === 'packages/client'), false);

    const manual = await discoverProjectEntry(root, 'packages/client', { source: 'manual' });
    assert.equal(manual.path, 'packages/client');
    assert.deepEqual(manual.labels, ['Node.js']);
    assert.equal(manual.checks.find((check) => check.id === 'node-script:lint').description, 'npm run lint');
  } finally {
    await cleanup();
  }
});

test('project selection removes commands belonging to unselected subprojects', async () => {
  const { root, cleanup } = await fixture();
  try {
    await write(root, 'pyproject.toml', '[project]\nname="workspace"\n');
    await write(root, 'web/package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    const project = await discoverProject(root);
    const rootOnly = applyProjectSelection(project, ['.']);

    assert.deepEqual(rootOnly.activeProjects.map((entry) => entry.path), ['.']);
    assert.equal(rootOnly.checks.some((check) => check.cwd === 'web'), false);
  } finally {
    await cleanup();
  }
});

test('saved project selection is restored after automatic discovery on startup', async () => {
  const { root, cleanup } = await fixture();
  try {
    await write(root, 'pyproject.toml', '[project]\nname="workspace"\n');
    await write(root, 'web/package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    const discovered = await discoverProject(root);
    const configured = await configureWorkspaceProjects(discovered, [{
      path: '.', typeIds: ['python'], labels: ['Python'], source: 'detected', selected: true,
    }]);

    assert.deepEqual(configured.activeProjects.map((entry) => entry.path), ['.']);
    assert.equal(configured.checks.some((check) => check.cwd === 'web'), false);
    assert.deepEqual(configured.workspaceLabels, ['Python']);
  } finally {
    await cleanup();
  }
});

test('command syntax separates cwd from the shell command and validates it', async () => {
  const { root, cleanup } = await fixture();
  try {
    await mkdir(path.join(root, 'web'), { recursive: true });
    assert.deepEqual(parseCommandSpec('npm test'), {
      input: 'npm test', cwd: '.', commandText: 'npm test', hasExplicitCwd: false,
    });
    assert.deepEqual(parseCommandSpec('web/ :: npm test'), {
      input: 'web/ :: npm test', cwd: 'web', commandText: 'npm test', hasExplicitCwd: true,
    });
    assert.equal(formatCommandSpec({ cwd: 'web', commandText: 'npm test' }), 'web/ :: npm test');
    assert.equal((await validateCommandSpec(root, 'web/ :: npm test')).cwd, 'web');
    await assert.rejects(() => validateCommandSpec(root, '../outside :: npm test'), /escapes the project root/i);
    await assert.rejects(() => validateCommandSpec(root, 'missing/ :: npm test'), /not found/i);
  } finally {
    await cleanup();
  }
});

test('checks and deployment commands run from configured subdirectories', async () => {
  const { root, cleanup } = await fixture();
  try {
    await mkdir(path.join(root, 'web'), { recursive: true });
    await write(root, 'web/valid.js', 'export const value = 1;\n');
    const executable = JSON.stringify(process.execPath);
    const workflow = {
      checks: [{
        id: 'cwd-check', name: 'CWD check', kind: 'custom', type: 'custom', selected: true, required: true,
        commandText: `${executable} -e "console.log(process.cwd())"`, cwd: 'web', timeoutMs: 10_000,
      }, {
        id: 'web-syntax', name: 'Web syntax', kind: 'node-syntax', type: 'syntax', selected: true, required: true,
        cwd: 'web', timeoutMs: 10_000,
      }],
    };

    const checks = await runChecks({ workflow, projectPath: root, changedPaths: ['web/valid.js'] });
    assert.equal(checks.ok, true);
    assert.match(checks.results[0].stdout, new RegExp(`${path.sep}web`));
    assert.equal(checks.results[1].ok, true);
    assert.equal(checks.results[0].cwd, 'web');

    const deploy = await runDeploy({
      projectPath: root,
      deploy: { commandText: `${executable} -e "console.log(process.cwd())"`, cwd: 'web', timeoutMs: 10_000 },
    });
    assert.equal(deploy.ok, true);
    assert.match(deploy.stdout, new RegExp(`${path.sep}web`));
  } finally {
    await cleanup();
  }
});

test('workflow version stores selected projects and migrates legacy workflows to root', async () => {
  const { root, cleanup } = await fixture();
  try {
    await write(root, 'package.json', '{"name":"root"}');
    await write(root, 'web/package.json', '{"name":"web"}');
    const project = await discoverProject(root);
    const workflow = createRecommendedWorkflow(project);

    assert.equal(WORKFLOW_VERSION, 8);
    assert.deepEqual(workflow.projects.map((entry) => entry.path), ['.', 'web']);
    assert.equal(workflow.checks.some((check) => check.cwd === 'web'), true);

    const migrated = normalizeWorkflow({
      version: 7,
      name: 'legacy',
      projectPath: root,
      projectTypes: ['node'],
      projectLabels: ['Node.js'],
      checks: [],
    });
    assert.equal(migrated.version, 8);
    assert.deepEqual(migrated.projects, [{
      path: '.', typeIds: ['node'], labels: ['Node.js'], source: 'legacy', selected: true,
    }]);
  } finally {
    await cleanup();
  }
});
