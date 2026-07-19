import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createPlanPatch } from '../src/patch/create.js';
import { tempDir, writeFiles } from '../test-support/helpers.js';

test('creates a persisted unified patch from the local snapshot and archive files', async () => {
  const home = await tempDir('zipflow-patch-home-');
  const root = await tempDir('zipflow-patch-project-');
  const archive = await tempDir('zipflow-patch-archive-');
  process.env.ZIPFLOW_HOME = home;
  try {
    await writeFiles(root, { 'src/update.js': 'const value = 1;\n', 'src/delete.js': 'remove\n' });
    await writeFiles(archive, { 'src/update.js': 'const value = 2;\n', 'src/create.js': 'create\n' });
    const plan = {
      created: [{ kind: 'created', path: 'src/create.js', sourcePath: path.join(archive, 'src/create.js'), currentPath: path.join(root, 'src/create.js') }],
      updated: [{ kind: 'updated', path: 'src/update.js', sourcePath: path.join(archive, 'src/update.js'), currentPath: path.join(root, 'src/update.js') }],
      deleted: [{ kind: 'deleted', path: 'src/delete.js', currentPath: path.join(root, 'src/delete.js') }],
    };

    const result = await createPlanPatch('run-test', plan);
    const content = await readFile(result.path, 'utf8');

    assert.match(content, /diff --git a\/src\/update\.js b\/src\/update\.js/);
    assert.match(content, /-const value = 1;/);
    assert.match(content, /\+const value = 2;/);
    assert.match(content, /new file mode/);
    assert.match(content, /deleted file mode/);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});
