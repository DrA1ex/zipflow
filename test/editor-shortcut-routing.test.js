import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isEditorScreen } from '../src/app/controller-screen-rules.js';

test('every controller editor screen bypasses global printable shortcuts', async () => {
  const appFiles = await javascriptFiles('src/app');
  const screens = new Set();
  for (const file of appFiles) {
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(/\.showEditor\(\s*['"]([^'"]+)['"]/g)) screens.add(match[1]);
  }

  assert.ok(screens.size > 0);
  assert.deepEqual(
    [...screens].filter((screen) => !isEditorScreen(screen)),
    [],
    'showEditor screens must be routed to the editor before global shortcuts',
  );
});

async function javascriptFiles(root) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await javascriptFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.js')) result.push(target);
  }
  return result;
}
