import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptDocumentSource, scrollPromptDocument } from '../src/ui/prompt-document.js';

const theme = {
  accent: '\x1b[36m', text: '\x1b[37m', textMuted: '\x1b[2m',
  success: '\x1b[32m', danger: '\x1b[31m', syntaxKeyword: '\x1b[35m',
  syntaxNumber: '\x1b[33m', syntaxString: '\x1b[32m',
};

test('prompt documents use a reusable virtual line source with code and diff highlighting', () => {
  const source = createPromptDocumentSource({
    requests: [{
      label: 'Historical request', provider: 'codex', model: 'gpt-test', structured: true, maxTokens: 1024,
      messages: [{
        role: 'user',
        content: [
          'Inspect this change:',
          '```javascript',
          'const answer = 42;',
          '```',
          'diff --git a/src/a.js b/src/a.js',
          '@@ -1 +1 @@',
          '-oldValue',
          '+newValue',
        ].join('\n'),
      }],
    }],
  }, { width: 48, theme });

  assert.equal(typeof source.getLine, 'function');
  assert.ok(source.length >= 10);
  const rendered = Array.from({ length: source.length }, (_, index) => source.getLine(index)).join('\n');
  assert.match(rendered, /REQUEST 1 · Historical request/);
  assert.match(rendered, /\x1b\[35mconst\x1b\[0m/);
  assert.match(rendered, /\x1b\[31m[^\n]*-oldValue/);
  assert.match(rendered, /\x1b\[32m[^\n]*\+newValue/);
});

test('prompt scrolling updates synchronously and clamps without queued menu navigation', () => {
  const view = { scroll: 0, maxScroll: 200 };
  for (let index = 0; index < 120; index += 1) scrollPromptDocument(view, 1);
  assert.equal(view.scroll, 120);
  scrollPromptDocument(view, 500);
  assert.equal(view.scroll, 200);
  scrollPromptDocument(view, -1_000);
  assert.equal(view.scroll, 0);
});


test('large prompt documents highlight only visible chunks on first open', () => {
  const source = createPromptDocumentSource({
    requests: [{
      label: 'Large request', provider: 'codex', model: 'gpt-test', structured: false, maxTokens: 4096,
      messages: [{
        role: 'user',
        content: ['```javascript', ...Array.from({ length: 4_000 }, (_, index) => `const value_${index} = ${index};`), '```'].join('\n'),
      }],
    }],
  }, { width: 80, theme });

  const before = source.getDiagnostics();
  assert.equal(before.renderedChunks, 0);
  assert.ok(before.chunks > 20);
  assert.ok(source.length > 4_000);

  for (let index = 0; index < 24; index += 1) source.getLine(index);
  const visible = source.getDiagnostics();
  assert.equal(visible.renderedChunks, 1);
  assert.ok(visible.renderedLines <= visible.chunkLines);

  for (let index = 0; index < 24; index += 1) source.getLine(index);
  assert.equal(source.getDiagnostics().renderedChunks, 1);

  source.getLine(600);
  assert.equal(source.getDiagnostics().renderedChunks, 2);
});
