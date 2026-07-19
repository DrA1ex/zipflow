import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = ['bin', 'src', 'test', 'test-support', 'scripts'];
const files = roots.flatMap(collect).filter((file) => file.endsWith('.js'));
let failed = false;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n').length;
  if (lines > 1000) {
    console.error(`${file}: ${lines} lines (hard limit 1000)`);
    failed = true;
  } else if (lines > 500) {
    console.warn(`${file}: ${lines} lines (preferred limit 500 exceeded)`);
  }
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
if (failed) process.exitCode = 1;
else console.log(`Checked ${files.length} JavaScript files.`);

function collect(root) {
  try {
    return statSync(root).isDirectory()
      ? readdirSync(root).flatMap((entry) => collect(path.join(root, entry)))
      : [root];
  } catch {
    return [];
  }
}
