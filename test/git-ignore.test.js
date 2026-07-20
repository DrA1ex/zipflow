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

test('recommended gitignore is created only when the file is missing', async () => {
  const root = await tempDir('zipflow-ignore-create-');
  await writeFiles(root, { 'package.json': '{}\n' });
  const project = await discoverProject(root);

  const first = await addRecommendedGitignore(project);
  const before = await readFile(path.join(root, '.gitignore'), 'utf8');
  const second = await addRecommendedGitignore(project);
  const after = await readFile(path.join(root, '.gitignore'), 'utf8');

  assert.equal(first.created, true);
  assert.equal(first.changed, true);
  assert.equal(second.created, false);
  assert.equal(second.changed, false);
  assert.equal(second.existing, true);
  assert.equal(after, before);
  assert.match(after, /node_modules\//);
});

test('an existing gitignore is preserved byte-for-byte', async () => {
  const root = await tempDir('zipflow-ignore-existing-');
  const original = '# User-owned rules\r\n!important.log\r\ncustom-cache/\r\n';
  await writeFiles(root, {
    'package.json': '{}\n',
    '.gitignore': original,
  });
  const project = await discoverProject(root);

  const result = await addRecommendedGitignore(project);
  const after = await readFile(path.join(root, '.gitignore'), 'utf8');

  assert.equal(result.created, false);
  assert.equal(result.changed, false);
  assert.equal(result.existing, true);
  assert.equal(after, original);
});

test('the matcher uses existing user rules without Zipflow modifying them', async () => {
  const root = await tempDir('zipflow-ignore-matcher-');
  const original = '*.log\n!important.log\n';
  await writeFiles(root, {
    'package.json': '{}\n',
    '.gitignore': original,
  });
  const project = await discoverProject(root);

  await addRecommendedGitignore(project);
  const matcher = await createRootGitignoreMatcher(root);
  const text = await readFile(path.join(root, '.gitignore'), 'utf8');

  assert.equal(matcher('debug.log'), true);
  assert.equal(matcher('important.log'), false);
  assert.equal(text, original);
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

test('Swift projects receive Xcode and SwiftPM ignore recommendations', async () => {
  const { recommendedGitignoreGroups } = await import('../src/git/ignore.js');
  const groups = recommendedGitignoreGroups({ technologies: [{ id: 'swift' }], labels: ['Swift · macOS'] });
  const swift = groups.find((group) => group.title === 'Swift and Xcode');
  assert.ok(swift.patterns.includes('.build/'));
  assert.ok(swift.patterns.includes('DerivedData/'));
  assert.ok(swift.patterns.includes('xcuserdata/'));
});
