import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { renderToString } from 'terlio.js';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { refreshPathSuggestions } from '../src/app/path-suggestions.js';
import { renderZipflow } from '../src/ui/render.js';
import { tempDir } from '../test-support/helpers.js';

function controllerFixture(root) {
  const state = createInitialState();
  state.project = { name: 'fixture', root, labels: ['Node.js'], git: true };
  const controller = new ZipflowController(state);
  controller.invalidate = () => {};
  return { state, controller };
}

test('archive path editor shows multiple live suggestions in an overlay', async () => {
  const root = await tempDir('zipflow-path-overlay-');
  await mkdir(path.join(root, 'updates'));
  await writeFile(path.join(root, 'one.zip'), 'zip');
  await writeFile(path.join(root, 'two.zip'), 'zip');
  const { state, controller } = controllerFixture(root);
  controller.showEditor('archive-input', { label: 'ZIP archive path', purpose: 'archive-path' }, `${root}${path.sep}`);
  await refreshPathSuggestions(controller);

  const output = renderToString(renderZipflow({ state, width: 100, height: 30 }), { width: 100, height: 30 });

  assert.match(output, /one\.zip/);
  assert.match(output, /updates\//);
  assert.match(output, /3 matches/);
  assert.match(output, /Tab\/Enter complete/);

  await controller.handleKey({ name: 'down' });
  await controller.handleKey({ name: 'down' });
  const scrolled = renderToString(renderZipflow({ state, width: 100, height: 30 }), { width: 100, height: 30 });
  assert.match(scrolled, /two\.zip/);
});

test('Tab opens a selected directory while a selected file completes the path', async () => {
  const root = await tempDir('zipflow-path-navigation-');
  const nested = path.join(root, 'updates');
  await mkdir(nested);
  await writeFile(path.join(nested, 'release.zip'), 'zip');
  const { state, controller } = controllerFixture(root);
  controller.showEditor('archive-input', { label: 'ZIP archive path', purpose: 'archive-path' }, `${root}${path.sep}`);
  await refreshPathSuggestions(controller);
  state.pathSuggestions.selectedIndex = state.pathSuggestions.items.findIndex((item) => item.label === 'updates/');

  await controller.handleKey({ name: 'tab' });

  assert.match(state.editor.value, /updates\/$/);
  assert.equal(state.screen, 'archive-input');
  assert.ok(state.pathSuggestions.items.some((item) => item.label === 'release.zip'));
});
