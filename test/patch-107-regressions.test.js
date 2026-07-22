import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InputActionGate } from '../src/app/input-action-gate.js';
import { insertPastedText, pastedTextFromKey } from '../src/ui/editor-paste.js';
import { scoreArchiveMatch } from '../src/archive/discovery-match.js';
import { inferLanguage, parseRichTextBlocks, standaloneCode } from '../src/ui/rich-text.js';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));

test('multiline paste is one atomic editor replacement and is never interpreted as Enter', () => {
  const editor = {
    value: 'subject', cursor: 7, insertions: [], replacements: [],
    insert(value) { this.insertions.push(value); this.value += value; },
    set(value) { this.replacements.push(value); this.value = value; this.cursor = value.length; },
  };
  const key = { name: 'paste', text: '\n\nDetailed body\nSecond line' };
  const pasted = pastedTextFromKey(key);
  insertPastedText(editor, pasted, { multiline: true });

  assert.equal(pasted, '\n\nDetailed body\nSecond line');
  assert.deepEqual(editor.insertions, []);
  assert.deepEqual(editor.replacements, ['subject\n\nDetailed body\nSecond line']);
  assert.equal(editor.value, 'subject\n\nDetailed body\nSecond line');
  assert.equal(editor.cursor, editor.value.length);
  assert.equal(pastedTextFromKey({ name: 'enter' }), null);
});

test('single-line editors flatten pasted newlines without submitting', () => {
  const editor = { value: '', insert(value) { this.value += value; } };
  insertPastedText(editor, pastedTextFromKey({ printable: true, text: 'one\r\ntwo\nthree' }), { multiline: false });
  assert.equal(editor.value, 'one two three');
});

test('input action gate permits only one concurrent submit', async () => {
  const gate = new InputActionGate();
  let calls = 0;
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const first = gate.run(async () => { calls += 1; await blocker; });
  const second = gate.run(async () => { calls += 1; });

  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(calls, 1);
});

test('archive matching strips one wrapper and accepts a specific one-file update', () => {
  const project = ['package.json', 'src/app.js', 'src/config.js', 'README.md'];
  const wrapped = scoreArchiveMatch(project, ['release/src/app.js']);
  assert.equal(wrapped.suitable, true);
  assert.equal(wrapped.wrapper, 'release');
  assert.deepEqual(wrapped.exactPaths, ['src/app.js']);

  const readmeOnly = scoreArchiveMatch(project, ['unrelated/README.md']);
  assert.equal(readmeOnly.suitable, false);
});

test('rich text recognizes fenced code, complete JSON, and streaming JSON language', () => {
  const blocks = parseRichTextBlocks(['Before', '```js', 'const answer = 42;', '```', 'After']);
  assert.deepEqual(blocks.map((block) => block.type), ['text', 'code', 'text']);
  assert.equal(blocks[1].language, 'javascript');
  assert.equal(blocks[1].code, 'const answer = 42;');

  const json = standaloneCode('{"summary":["done"],"commitMessage":"Update"}');
  assert.equal(json.language, 'json');
  assert.match(json.code, /\n  "summary"/);
  assert.equal(inferLanguage('{"action":"apply",'), 'json');
});

test('1.0.8 requires Terlio 1.1.3 in package metadata and lockfile', () => {
  assert.equal(packageJson.version, '1.0.8');
  assert.equal(packageJson.dependencies['terlio.js'], '^1.1.3');
  assert.equal(packageLock.version, '1.0.8');
  assert.equal(packageLock.packages[''].dependencies['terlio.js'], '^1.1.3');
  assert.equal(packageLock.packages['node_modules/terlio.js'].version, '1.1.3');
  assert.equal(packageLock.packages['node_modules/terlio.js'].resolved, 'https://registry.npmjs.org/terlio.js/-/terlio.js-1.1.3.tgz');
});
