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
  assert.match(rendered, /\x1b\[31m-oldValue/);
  assert.match(rendered, /\x1b\[32m\+newValue/);
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
