import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ProgressBar, Text, renderToString, themes } from 'terlio.js';
import { copyZipflowText, normalizeClipboardResult } from '../src/ui/clipboard.js';
import { renderSyntaxLines } from '../src/ui/syntax-render.js';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const shrinkwrap = JSON.parse(await readFile(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'));

function dependencyVersion(document) {
  return {
    requested: document.packages[''].dependencies['terlio.js'],
    installed: document.packages['node_modules/terlio.js'].version,
    resolved: document.packages['node_modules/terlio.js'].resolved,
  };
}

test('Zipflow pins Terlio.js 1.2.0 in public package metadata', () => {
  assert.equal(packageJson.dependencies['terlio.js'], '1.2.0');
  const expected = {
    requested: '1.2.0',
    installed: '1.2.0',
    resolved: 'https://registry.npmjs.org/terlio.js/-/terlio.js-1.2.0.tgz',
  };
  assert.deepEqual(dependencyVersion(packageLock), expected);
  assert.deepEqual(dependencyVersion(shrinkwrap), expected);
});

test('clipboard compatibility normalizes Terlio 1.2 structured results', async () => {
  assert.equal(normalizeClipboardResult(true), true);
  assert.equal(normalizeClipboardResult(false), false);
  assert.equal(normalizeClipboardResult({ copied: true, backend: 'native' }), true);
  assert.equal(normalizeClipboardResult({ copied: false, backend: 'native', reason: 'unavailable' }), false);

  const calls = [];
  const output = { write() {} };
  const copied = copyZipflowText('result', {
    output,
    copyImpl(text, options) {
      calls.push({ text, options });
      return { copied: false, backend: 'native', reason: 'unavailable' };
    },
  });
  assert.equal(copied, false);
  assert.equal(calls[0].text, 'result');
  assert.equal(calls[0].options.output, output);
  assert.equal(calls[0].options.clipboardPolicy, 'auto');

  const asyncCopied = await copyZipflowText('async', {
    copyImpl: async () => ({ copied: true, backend: 'osc52' }),
  });
  assert.equal(asyncCopied, true);

  const renderSource = await readFile(new URL('../src/ui/render.js', import.meta.url), 'utf8');
  assert.doesNotMatch(renderSource, /copyZipflowText\([^\n]+\)\.copied/);
});

test('Zipflow retains process signal ownership instead of delegating it to Terlio', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /processHandlers:\s*'none'/);
  assert.match(source, /registerSigintHandler\(controller\)/);
});

test('Terlio 1.2 syntax styling remains ANSI-styled through the safe Text renderer', () => {
  const syntax = renderSyntaxLines('{"ok":true}', 'json', { width: 60, theme: themes.ocean }).join('\n');
  assert.match(syntax, /\x1b\[[0-9;]*m/);
  const rendered = renderToString(Text(syntax, { wrap: false }), 80);
  assert.match(rendered, /\x1b\[[0-9;]*m/);
  assert.match(rendered, /ok/);
});

test('Terlio 1.2 progress rendering uses smooth fractional blocks rather than hash filling', () => {
  const rendered = renderToString(ProgressBar({ value: 42, total: 100, width: 32, theme: themes.ocean }), 32);
  assert.match(rendered, /42%/);
  assert.match(rendered, /[█▉▊▋▌▍▎▏]/u);
  assert.doesNotMatch(rendered, /#+/);
});
