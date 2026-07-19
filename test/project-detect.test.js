import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { discoverProject } from '../src/project/detect.js';
import { tempDir, writeFiles, initGit } from '../test-support/helpers.js';

test('discovers the Git project root and Node.js checks from a nested directory', async () => {
  const root = await tempDir();
  await writeFiles(root, {
    'package.json': JSON.stringify({ name: 'fixture-app', scripts: { test: 'node --test', lint: 'eslint .', 'test:e2e': 'playwright test' } }),
    'package-lock.json': '{}',
    'tsconfig.json': '{}',
    'src/index.js': 'export const value = 1;\n',
  });
  await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await initGit(root);

  const project = await discoverProject(path.join(root, 'src', 'nested'));

  assert.equal(project.root, root);
  assert.equal(project.name, 'fixture-app');
  assert.equal(project.git, true);
  assert.deepEqual(project.technologies.map((item) => item.id), ['node']);
  assert.equal(project.checks.find((item) => item.id === 'node-script:test').selected, true);
  assert.equal(project.checks.find((item) => item.id === 'node-script:test:e2e').selected, false);
});

test('a malformed package.json does not prevent project setup', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'package.json': '{ invalid', 'src/index.js': 'export {};\n' });

  const project = await discoverProject(root);

  assert.deepEqual(project.technologies.map((item) => item.id), ['node']);
  assert.match(project.notes[0], /package\.json could not be parsed/);
  assert.equal(project.checks.some((item) => item.id === 'node-syntax'), true);
});

test('discovers a marker root without Git from a nested directory', async () => {
  const root = await tempDir('zipflow-marker-root-');
  await writeFiles(root, {
    'pyproject.toml': '[project]\nname="fixture"\n',
    'src/module.py': 'value = 1\n',
  });
  await mkdir(path.join(root, 'src', 'nested'), { recursive: true });

  const project = await discoverProject(path.join(root, 'src', 'nested'));

  assert.equal(project.root, root);
  assert.equal(project.git, false);
  assert.deepEqual(project.technologies.map((item) => item.id), ['python']);
});

test('uses the Git root when a nested package also has a project marker', async () => {
  const root = await tempDir('zipflow-git-root-priority-');
  await writeFiles(root, {
    'package.json': '{"name":"workspace-root"}\n',
    'packages/child/package.json': '{"name":"workspace-child"}\n',
  });
  await initGit(root);

  const project = await discoverProject(path.join(root, 'packages', 'child'));

  assert.equal(project.root, root);
  assert.equal(project.name, 'workspace-root');
});

test('detects multiple project technologies in deterministic order', async () => {
  const root = await tempDir('zipflow-multi-project-');
  await writeFiles(root, {
    'package.json': '{"name":"multi"}\n',
    'pyproject.toml': '[project]\nname="multi"\n',
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\n',
    'go.mod': 'module example.test/multi\n',
  });

  const project = await discoverProject(root);

  assert.deepEqual(project.technologies.map((item) => item.id), ['node', 'python', 'cmake', 'go']);
  assert.ok(project.checks.some((item) => item.id === 'python-syntax'));
  assert.ok(project.checks.some((item) => item.id === 'go-test'));
  assert.ok(project.checks.some((item) => item.id === 'cmake-build'));
});

test('declared Node package manager takes precedence over lockfiles', async () => {
  const root = await tempDir('zipflow-package-manager-');
  await writeFiles(root, {
    'package.json': JSON.stringify({ packageManager: 'pnpm@9.15.0', scripts: { test: 'node --test' } }),
    'package-lock.json': '{}\n',
  });

  const project = await discoverProject(root);
  const node = project.technologies.find((item) => item.id === 'node');

  assert.equal(node.details.packageManager, 'pnpm');
  assert.deepEqual(project.checks.find((item) => item.id === 'node-script:test').command, ['pnpm', 'run', 'test']);
});

test('dangerous lifecycle and release scripts are not offered as checks', async () => {
  const root = await tempDir('zipflow-script-filter-');
  await writeFiles(root, {
    'package.json': JSON.stringify({
      scripts: {
        test: 'node --test',
        deploy: 'upload-production',
        release: 'publish-release',
        postinstall: 'generate-assets',
        build: 'node build.js',
      },
    }),
  });

  const project = await discoverProject(root);
  const ids = project.checks.map((item) => item.id);

  assert.ok(ids.includes('node-script:test'));
  assert.ok(ids.includes('node-script:build'));
  assert.equal(ids.some((id) => /deploy|release|postinstall/.test(id)), false);
});

test('a directory with no markers remains usable as an unknown project', async () => {
  const root = await tempDir('zipflow-unknown-project-');
  await writeFiles(root, { 'notes.txt': 'plain directory\n' });

  const project = await discoverProject(root);

  assert.equal(project.root, root);
  assert.equal(project.git, false);
  assert.deepEqual(project.technologies, []);
  assert.deepEqual(project.checks, []);
  assert.equal(project.name, path.basename(root));
});
