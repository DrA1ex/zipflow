import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  addRecommendedGitignore,
  createRootGitignoreMatcher,
  recommendedGitignoreGroups,
} from '../src/git/ignore.js';
import { discoverProject } from '../src/project/detect.js';
import { tempDir, writeFiles } from '../test-support/helpers.js';

test('recommended gitignore is idempotent', async () => {
  const root = await tempDir('zipflow-ignore-idempotent-');
  await writeFiles(root, { 'package.json': '{}\n' });
  const project = await discoverProject(root);

  const first = await addRecommendedGitignore(project);
  const before = await readFile(path.join(root, '.gitignore'), 'utf8');
  const second = await addRecommendedGitignore(project);
  const after = await readFile(path.join(root, '.gitignore'), 'utf8');

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(after, before);
});

test('existing user negation rules remain effective after recommendations are added', async () => {
  const root = await tempDir('zipflow-ignore-negation-');
  await writeFiles(root, {
    'package.json': '{}\n',
    '.gitignore': '!important.log\n',
  });
  const project = await discoverProject(root);

  await addRecommendedGitignore(project);
  const matcher = await createRootGitignoreMatcher(root);
  const text = await readFile(path.join(root, '.gitignore'), 'utf8');

  assert.equal(matcher('debug.log'), true);
  assert.equal(matcher('important.log'), false);
  assert.ok(text.indexOf('*.log') < text.indexOf('!important.log'));
});

test('recommended groups include every detected technology without duplicate base groups', async () => {
  const root = await tempDir('zipflow-ignore-multi-');
  await writeFiles(root, {
    'package.json': '{}\n',
    'tsconfig.json': '{}\n',
    'pyproject.toml': '[project]\nname="fixture"\n',
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\n',
    'go.mod': 'module example.test/fixture\n',
  });
  const project = await discoverProject(root);
  const groups = recommendedGitignoreGroups(project);
  const titles = groups.map((group) => group.title);

  assert.equal(new Set(titles).size, titles.length);
  assert.ok(titles.includes('Node.js'));
  assert.ok(titles.includes('TypeScript'));
  assert.ok(titles.includes('Python'));
  assert.ok(titles.includes('CMake and C++'));
  assert.ok(titles.includes('Go'));
});
