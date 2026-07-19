import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import yazl from 'yazl';
import { runProcess } from '../src/utils/process.js';
import { hashFile } from '../src/utils/hash.js';

export async function tempDir(prefix = 'zipflow-test-') {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export async function initGit(root) {
  await runProcess('git', ['init', '-q'], { cwd: root });
  await runProcess('git', ['config', 'user.email', 'zipflow@test.local'], { cwd: root });
  await runProcess('git', ['config', 'user.name', 'Zipflow Tests'], { cwd: root });
  await runProcess('git', ['add', '--all'], { cwd: root });
  await runProcess('git', ['commit', '-qm', 'fixture'], { cwd: root });
}

export async function extractedFixture(root, files) {
  const sourceRoot = path.join(root, 'archive');
  await writeFiles(sourceRoot, files);
  const entries = [];
  for (const relative of Object.keys(files)) {
    entries.push({
      path: relative,
      relativePath: relative,
      absolutePath: path.join(sourceRoot, relative),
      mode: 0o644,
      size: Buffer.byteLength(files[relative]),
      hash: await hashFile(path.join(sourceRoot, relative)),
    });
  }
  return { root: sourceRoot, rootPrefix: null, entries, fileCount: entries.length };
}


export async function createZip(target, files) {
  const zip = new yazl.ZipFile();
  for (const [relative, content] of Object.entries(files)) {
    zip.addBuffer(Buffer.from(content), relative);
  }
  const done = new Promise((resolve, reject) => {
    const output = createWriteStream(target);
    output.on('close', resolve);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
  });
  zip.end();
  await done;
  return target;
}
