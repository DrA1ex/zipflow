import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadPlanItemDiff, sideBySideDiffLines, unifiedDiffLines } from '../src/diff/file.js';
import { tempDir } from '../test-support/helpers.js';

test('file diff supports unified and side-by-side representations', async () => {
  const root = await tempDir('zipflow-diff-');
  const currentPath = path.join(root, 'current.js');
  const sourcePath = path.join(root, 'archive.js');
  await writeFile(currentPath, 'const a = 1;\nkeep();\nremove();\n');
  await writeFile(sourcePath, 'const a = 2;\nkeep();\nadd();\n');
  const diff = await loadPlanItemDiff({ kind: 'updated', path: 'src/index.js', currentPath, sourcePath });

  const unified = unifiedDiffLines(diff).map((line) => typeof line === 'string' ? line : line.text);
  assert.ok(unified.some((line) => line === '-const a = 1;'));
  assert.ok(unified.some((line) => line === '+const a = 2;'));
  const side = sideBySideDiffLines(diff, 100);
  assert.ok(side.some((line) => line.type === 'change' || line.type === 'remove'));
  assert.ok(side.some((line) => line.type === 'add' || line.type === 'change'));
});

test('large or binary files produce a safe informational diff', async () => {
  const root = await tempDir('zipflow-diff-binary-');
  const currentPath = path.join(root, 'before.bin');
  const sourcePath = path.join(root, 'after.bin');
  await writeFile(currentPath, Buffer.from([0, 1, 2]));
  await writeFile(sourcePath, Buffer.from([0, 3, 4]));
  const diff = await loadPlanItemDiff({ kind: 'updated', path: 'asset.bin', currentPath, sourcePath });
  assert.equal(diff.binary, true);
  assert.match(unifiedDiffLines(diff)[0], /Binary or large file/);
});
