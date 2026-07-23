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

test('diff view scrolls with the mouse wheel', async () => {
  const { renderToFrame, TerminalRenderer } = await import('terlio.js');
  const { createInitialState } = await import('../src/app/state.js');
  const { renderZipflow } = await import('../src/ui/render.js');
  const rows = Array.from({ length: 120 }, (_, index) => ({
    type: 'add', oldNo: null, newNo: index + 1, oldText: '', newText: `added line ${index + 1}`,
  }));
  const state = createInitialState();
  state.project = { name: 'fixture', root: '/tmp/fixture', labels: ['Node.js'], git: true };
  state.workflow = { policy: { label: 'Practical' } };
  state.screen = 'diff-view';
  state.status = 'Diff';
  state.diffView = {
    diff: { path: 'src/large.js', binary: false, rows, kind: 'updated' },
    mode: 'unified', hunkIndex: 0, scroll: 0,
  };
  const frame = renderToFrame(renderZipflow({ state, width: 100, height: 30 }), { width: 100, height: 30 });
  const renderer = new TerminalRenderer({ output: { write() {} } });
  renderer.pointerRegions = frame.pointerRegions;

  const result = renderer.dispatchPointer({
    type: 'pointer', x: 10, y: 10, action: 'wheel', name: 'wheel-down', deltaX: 0, deltaY: 1,
  }, { runtime: { output: { write() {} } } });

  assert.equal(result.event.handled, true);
  assert.equal(state.diffView.scroll, 1);
});
