import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { collectExportPaths, listExportTopLevel } from '../src/export/candidates.js';
import { createProjectArchive } from '../src/export/create.js';
import { extractArchive } from '../src/archive/extract.js';
import { readArchiveMetadata } from '../src/archive/metadata.js';
import { discoverProject } from '../src/project/detect.js';
import { initGit, tempDir, writeFiles } from '../test-support/helpers.js';

test('ZIP export modes distinguish tracked, ignored, selected, and all files', async () => {
  const root = await tempDir('zipflow-export-project-');
  await writeFiles(root, {
    '.gitignore': 'ignored/\n*.log\n',
    'package.json': '{"name":"fixture"}\n',
    'src/index.js': 'tracked\n',
  });
  await initGit(root);
  await writeFiles(root, {
    'notes.txt': 'untracked\n',
    '.env.example': 'SAFE=1\n',
    '.github/workflows/test.yml': 'name: test\n',
    'ignored/cache.txt': 'ignored\n',
    'debug.log': 'ignored\n',
    '.zipflow/private.txt': 'protected\n',
  });
  const project = await discoverProject(root);

  assert.deepEqual(await collectExportPaths({ project, mode: 'tracked' }), ['.gitignore', 'package.json', 'src/index.js']);
  assert.deepEqual(await collectExportPaths({ project, mode: 'nonignored' }), ['.env.example', '.github/workflows/test.yml', '.gitignore', 'notes.txt', 'package.json', 'src/index.js']);
  assert.deepEqual(await collectExportPaths({ project, mode: 'interactive', selectedRoots: ['src'] }), ['src/index.js']);
  assert.deepEqual(await collectExportPaths({ project, mode: 'all' }), ['.env.example', '.github/workflows/test.yml', '.gitignore', 'debug.log', 'ignored/cache.txt', 'notes.txt', 'package.json', 'src/index.js']);

  const topLevel = await listExportTopLevel(root);
  assert.equal(topLevel.some((entry) => entry.name === '.git'), false);
  assert.equal(topLevel.some((entry) => entry.name === '.zipflow'), false);
  assert.equal(topLevel.some((entry) => entry.name === '.env.example'), true);
  assert.equal(topLevel.some((entry) => entry.name === '.github'), true);
});

test('created project ZIP can carry the standard Zipflow commit message metadata', async () => {
  const root = await tempDir('zipflow-export-project-');
  const outputRoot = await tempDir('zipflow-export-output-');
  await writeFiles(root, { 'src/index.js': 'export const value = 1;\n' });
  const output = path.join(outputRoot, 'project.zip');

  const result = await createProjectArchive({
    projectRoot: root,
    paths: ['src/index.js'],
    outputPath: output,
    commitMessage: 'Export project fixture',
  });
  assert.equal(result.fileCount, 1);

  const extractedRoot = path.join(outputRoot, 'extracted');
  await mkdir(extractedRoot, { recursive: true });
  const extracted = await extractArchive(output, extractedRoot);
  const metadata = await readArchiveMetadata(extracted);
  assert.equal(metadata.commitMessage, 'Export project fixture');
  assert.equal(metadata.commitMessageSource, '.zipflow/commit-message.txt');
});
