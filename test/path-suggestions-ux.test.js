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

test('archive path editor keeps completion hidden until input starts, then overlays live suggestions', async () => {
  const root = await tempDir('zipflow-path-overlay-');
  await mkdir(path.join(root, 'updates'));
  await writeFile(path.join(root, 'one.zip'), 'zip');
  await writeFile(path.join(root, 'two.zip'), 'zip');
  const { state, controller } = controllerFixture(root);
  controller.showEditor('archive-input', { label: 'ZIP archive path', purpose: 'archive-path' }, '');
  await refreshPathSuggestions(controller);
  let output = renderToString(renderZipflow({ state, width: 100, height: 30 }), { width: 100, height: 30 });
  assert.doesNotMatch(output, /Path suggestions/);
  assert.equal(state.pathSuggestions, null);

  state.editor.set(`${root}${path.sep}`);
  state.pathSuggestionActive = true;
  await refreshPathSuggestions(controller);

  output = renderToString(renderZipflow({ state, width: 100, height: 30 }), { width: 100, height: 30 });

  assert.match(output, /one\.zip/);
  assert.match(output, /updates\//);
  assert.match(output, /Path suggestions 1\/3/);
  assert.match(output, /DIR\s+updates\//);

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
  state.pathSuggestionActive = true;
  await refreshPathSuggestions(controller);
  state.pathSuggestions.selectedIndex = state.pathSuggestions.items.findIndex((item) => item.label === 'updates/');

  await controller.handleKey({ name: 'tab' });

  assert.match(state.editor.value, /updates\/$/);
  assert.equal(state.screen, 'archive-input');
  assert.ok(state.pathSuggestions.items.some((item) => item.label === 'release.zip'));
});

test('selecting a ZIP completion only fills the editor until Enter is pressed again', async () => {
  const root = await tempDir('zipflow-path-select-only-');
  const archive = path.join(root, 'release.zip');
  await writeFile(archive, 'not-a-real-zip');
  const { state, controller } = controllerFixture(root);
  let submitted = 0;
  controller.submitCurrentEditor = async () => { submitted += 1; };
  controller.showEditor('archive-input', { label: 'ZIP archive path', purpose: 'archive-path' }, `${root}${path.sep}rel`);
  state.pathSuggestionActive = true;
  await refreshPathSuggestions(controller);

  await controller.handleKey({ name: 'tab' });

  assert.equal(state.editor.value, archive);
  assert.equal(submitted, 0);
  assert.equal(state.pathSuggestions, null);
  assert.match(state.status, /press Enter/i);

  await controller.handleKey({ name: 'enter' });
  assert.equal(submitted, 1);
});

test('path completion uses aligned DIR and ZIP markers without icons', async () => {
  const root = await tempDir('zipflow-path-icons-');
  await mkdir(path.join(root, 'updates'));
  await writeFile(path.join(root, 'release.zip'), 'zip');
  const { state, controller } = controllerFixture(root);
  controller.showEditor('archive-input', { label: 'ZIP archive path', purpose: 'archive-path' }, `${root}${path.sep}`);
  state.pathSuggestionActive = true;
  await refreshPathSuggestions(controller);

  const output = renderToString(renderZipflow({ state, width: 100, height: 30 }), { width: 100, height: 30 });
  assert.match(output, /DIR\s+updates\//);
  assert.match(output, /ZIP\s+release\.zip/);
  assert.doesNotMatch(output, /📁|📄|Directory|File/);
});
