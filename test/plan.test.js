import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { buildUpdatePlan } from '../src/plan/build.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { discoverProject } from '../src/project/detect.js';
import { tempDir, writeFiles, initGit, extractedFixture } from '../test-support/helpers.js';

async function fixture() {
  const root = await tempDir();
  await writeFiles(root, {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }),
    'src/a.js': 'export const a = 1;\n',
    'src/local.js': 'export const local = 1;\n',
    'src/remove.js': 'remove me\n',
  });
  await initGit(root);
  const project = await discoverProject(root);
  const workflow = createRecommendedWorkflow(project);
  return { root, project, workflow };
}

test('unrelated uncommitted changes do not create conflicts', async () => {
  const { root, project, workflow } = await fixture();
  await writeFile(path.join(root, 'src/local.js'), 'export const local = 2;\n');
  const extracted = await extractedFixture(root, { 'src/a.js': 'export const a = 2;\n' });

  const plan = await buildUpdatePlan({ project, workflow, extracted });

  assert.deepEqual(plan.updated.map((item) => item.path), ['src/a.js']);
  assert.equal(plan.conflicts.length, 0);
});

test('identical dirty target is unchanged and is not a conflict', async () => {
  const { root, project, workflow } = await fixture();
  const content = 'export const a = 7;\n';
  await writeFile(path.join(root, 'src/a.js'), content);
  const extracted = await extractedFixture(root, { 'src/a.js': content });

  const plan = await buildUpdatePlan({ project, workflow, extracted });

  assert.deepEqual(plan.unchanged.map((item) => item.path), ['src/a.js']);
  assert.equal(plan.conflicts.length, 0);
});

test('different archive content conflicts with a dirty target', async () => {
  const { root, project, workflow } = await fixture();
  await writeFile(path.join(root, 'src/a.js'), 'export const a = 5;\n');
  const extracted = await extractedFixture(root, { 'src/a.js': 'export const a = 9;\n' });

  const plan = await buildUpdatePlan({ project, workflow, extracted });

  assert.equal(plan.updated.length, 1);
  assert.deepEqual(plan.conflicts.map((item) => item.path), ['src/a.js']);
});

test('snapshot deletes clean tracked files but preserves excluded files', async () => {
  const { root, project, workflow } = await fixture();
  workflow.archive.mode = 'snapshot';
  const extracted = await extractedFixture(root, {
    'package.json': await readFile(path.join(root, 'package.json'), 'utf8'),
    'src/a.js': await readFile(path.join(root, 'src/a.js'), 'utf8'),
    'src/local.js': await readFile(path.join(root, 'src/local.js'), 'utf8'),
  });

  const plan = await buildUpdatePlan({ project, workflow, extracted });

  assert.deepEqual(plan.deleted.map((item) => item.path), ['src/remove.js']);
  assert.equal(plan.conflicts.length, 0);
});


test('tracked-only snapshot reports untracked missing files as preserved', async () => {
  const { root, project, workflow } = await fixture();
  workflow.archive.mode = 'snapshot';
  workflow.deletion.scope = 'tracked-only';
  workflow.exclude.push('archive/**');
  await writeFile(path.join(root, 'local-notes.txt'), 'keep me\n');
  const extracted = await extractedFixture(root, {
    'package.json': await readFile(path.join(root, 'package.json'), 'utf8'),
    'src/a.js': await readFile(path.join(root, 'src/a.js'), 'utf8'),
    'src/local.js': await readFile(path.join(root, 'src/local.js'), 'utf8'),
    'src/remove.js': await readFile(path.join(root, 'src/remove.js'), 'utf8'),
  });

  const plan = await buildUpdatePlan({ project, workflow, extracted });

  assert.deepEqual(plan.preserved.map((item) => item.path), ['local-notes.txt']);
  assert.equal(plan.counts.preserved, 1);
});

test('incoming .gitignore matches and .zipflow internals are always skipped', async () => {
  const root = await tempDir('zipflow-plan-ignore-');
  await writeFiles(root, {
    '.gitignore': 'ignored.txt\n',
    'package.json': '{"name":"fixture"}\n',
    'src/index.js': 'current\n',
  });
  await initGit(root);
  const project = await discoverProject(root);
  const workflow = createRecommendedWorkflow(project);
  workflow.archive.allowGitIgnoredIncomingFiles = 'ask';
  const extracted = await extractedFixture(root, {
    'ignored.txt': 'must not apply\n',
    '.zipflow/private.json': '{}\n',
    'src/new.js': 'apply\n',
  });

  const plan = await buildUpdatePlan({ project, workflow, extracted });

  assert.deepEqual(plan.created.map((item) => item.path), ['src/new.js']);
  assert.deepEqual(plan.skipped.map((item) => item.path), ['.zipflow/private.json', 'ignored.txt']);
  assert.match(plan.skipped.find((item) => item.path === 'ignored.txt').reason, /gitignore/i);
  assert.match(plan.skipped.find((item) => item.path === '.zipflow/private.json').reason, /protected/i);
});

test('snapshot all keeps files ignored by .gitignore', async () => {
  const root = await tempDir('zipflow-plan-snapshot-ignore-');
  await writeFiles(root, {
    '.gitignore': 'ignored/\n',
    'package.json': '{"name":"fixture"}\n',
    'src/index.js': 'current\n',
    'ignored/local.db': 'keep\n',
  });
  await initGit(root);
  const project = await discoverProject(root);
  const workflow = createRecommendedWorkflow(project);
  workflow.archive.mode = 'snapshot';
  workflow.deletion.scope = 'all';
  workflow.exclude.push('archive/**');
  const extracted = await extractedFixture(root, {
    '.gitignore': 'ignored/\n',
    'package.json': '{"name":"fixture"}\n',
    'src/index.js': 'current\n',
  });

  const plan = await buildUpdatePlan({ project, workflow, extracted });

  assert.equal(plan.deleted.some((item) => item.path === 'ignored/local.db'), false);
  assert.equal(plan.preserved.some((item) => item.path === 'ignored/local.db'), true);
});

test('ordinary dot-directories are synchronized while permanent sensitive dotfile exclusions stay enabled', async () => {
  const root = await tempDir('zipflow-plan-dotfiles-');
  await writeFiles(root, {
    'package.json': '{"name":"fixture"}\n',
    '.env': 'OLD=1\n',
    '.config/local.json': '{"old":true}\n',
  });
  await initGit(root);
  const project = await discoverProject(root);
  const workflow = createRecommendedWorkflow(project);
  const extracted = await extractedFixture(root, {
    '.env': 'NEW=2\n',
    '.config/local.json': '{"new":true}\n',
    '.github/workflows/test.yml': 'name: test\n',
    '.DS_Store': 'metadata\n',
  });

  const plan = await buildUpdatePlan({ project, workflow, extracted });

  assert.deepEqual(plan.created.map((item) => item.path), ['.github/workflows/test.yml']);
  assert.deepEqual(plan.updated.map((item) => item.path), ['.config/local.json']);
  assert.deepEqual(plan.skipped.map((item) => item.path).sort(), ['.DS_Store', '.env']);
  assert.ok(plan.skipped.every((item) => /workflow/i.test(item.reason)));
});

test('gitignore rules still apply to dot-directories in addition to permanent sensitive exclusions', async () => {
  const root = await tempDir('zipflow-plan-dotfiles-ignored-');
  await writeFiles(root, {
    '.gitignore': '.env\n.idea/\n',
    'package.json': '{"name":"fixture"}\n',
  });
  await initGit(root);
  const project = await discoverProject(root);
  const workflow = createRecommendedWorkflow(project);
  const extracted = await extractedFixture(root, {
    '.env': 'SECRET=1\n',
    '.idea/workspace.xml': '<xml/>\n',
    '.github/workflows/test.yml': 'name: test\n',
  });

  const plan = await buildUpdatePlan({ project, workflow, extracted });
  const reasons = Object.fromEntries(plan.skipped.map((item) => [item.path, item.reason]));

  assert.deepEqual(plan.created.map((item) => item.path), ['.github/workflows/test.yml']);
  assert.deepEqual(Object.keys(reasons).sort(), ['.env', '.idea/workspace.xml']);
  assert.match(reasons['.env'], /workflow/i);
  assert.match(reasons['.idea/workspace.xml'], /gitignore/i);
});

test('snapshot deletion treats tracked dotfiles like ordinary files', async () => {
  const root = await tempDir('zipflow-plan-dotfile-delete-');
  await writeFiles(root, {
    'package.json': '{"name":"fixture"}\n',
    '.config/tool.json': '{"enabled":true}\n',
  });
  await initGit(root);
  const project = await discoverProject(root);
  const workflow = createRecommendedWorkflow(project);
  workflow.archive.mode = 'snapshot';
  const extracted = await extractedFixture(root, {
    'package.json': '{"name":"fixture"}\n',
  });

  const plan = await buildUpdatePlan({ project, workflow, extracted });

  assert.deepEqual(plan.deleted.map((item) => item.path), ['.config/tool.json']);
});
