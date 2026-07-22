import test from 'node:test';
import assert from 'node:assert/strict';
import * as Terlio from 'terlio.js';
import { renderSyntaxLines, terlioSyntaxExportName } from '../src/ui/syntax-render.js';

test('Terlio 1.1.3 exposes a syntax highlighter recognized by Zipflow', () => {
  const name = terlioSyntaxExportName();
  assert.ok(name, `No supported syntax-highlighting export found. Available exports: ${Object.keys(Terlio).sort().join(', ')}`);
  const lines = renderSyntaxLines('{"ok":true}', 'json', { width: 60 });
  assert.ok(lines.length >= 1);
  assert.match(lines.join('\n'), /ok/);
});
