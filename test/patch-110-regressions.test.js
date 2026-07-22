import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('workflow setup lists are one-line and wheel events invalidate through controller dispatch', async () => {
  const render = await read('../src/ui/render.js');
  const controller = await read('../src/app/controller.js');
  assert.match(render, /const menuRows = selectRows\(state\.menuItems, \(item\) => menuItemLabel\(item, state\)\)/);
  assert.match(render, /items: menuRows/);
  assert.match(render, /getLabel: \(item\) => item\.label/);
  assert.doesNotMatch(render, /getDescription: \(item\) => inlineDescriptions/);
  assert.match(render, /wrapItems: false/);
  assert.match(render, /maxItemLines: 1/);
  assert.match(render, /oneLineLabel/);
  assert.match(render, /type: 'menu-move-selection'/);
  assert.match(controller, /action\.type === 'menu-move-selection'/);
});

test('all setup screens receive paging, search, and a two-row context dock', async () => {
  const render = await read('../src/ui/render.js');
  const rules = await read('../src/app/controller-screen-rules.js');
  assert.match(render, /isWorkflowSetupScreen\(screen\) \? 2 : 1/);
  assert.match(render, /startsWith\('setup-'\)/);
  assert.match(rules, /isPagedMenuScreen[\s\S]*startsWith\('setup-'\)/);
  assert.match(rules, /isSearchableScreen[\s\S]*startsWith\('setup-'\)/);
});

test('language is the first settings category and custom packs have a schema', async () => {
  const options = await read('../src/app/settings-options.js');
  const schema = JSON.parse(await read('../src/i18n/language.schema.json'));
  assert.match(options, /const definitions = \[\s*\{ id: 'language'/);
  assert.deepEqual(schema.required, ['version', 'id', 'locale', 'name', 'nativeName', 'messages']);
  assert.equal(schema.additionalProperties, false);
  assert.match(options, /action: 'refresh-languages'/);
});

test('model tests expose historical autopilot simulation', async () => {
  const options = await read('../src/app/settings-options.js');
  const panel = await read('../src/app/settings-panel.js');
  assert.match(options, /action: 'model-test-autopilot'/);
  assert.match(options, /action: 'autopilot-replay-run'/);
  assert.match(panel, /loadAutopilotReplayRuns/);
  assert.match(panel, /startHistoricalAutopilotSimulation/);
});
