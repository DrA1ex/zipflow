import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import yazl from 'yazl';
import { ensureDir } from '../utils/fs.js';
import { normalizeRelativePath } from '../plan/matcher.js';

export async function createProjectArchive({ projectRoot, paths, outputPath, commitMessage = null, onProgress = null }) {
  const absoluteOutput = path.resolve(outputPath);
  await ensureDir(path.dirname(absoluteOutput));
  const outputRelative = relativeInside(projectRoot, absoluteOutput);
  const uniquePaths = [...new Set(paths.map(normalizeRelativePath))]
    .filter((relative) => relative && relative !== outputRelative)
    .sort();
  if (!uniquePaths.length) throw new Error('No files were selected for the ZIP archive.');
  const zip = new yazl.ZipFile();
  let added = 0;
  for (const relative of uniquePaths) {
    const absolute = path.join(projectRoot, relative);
    const info = await stat(absolute);
    if (!info.isFile()) continue;
    zip.addFile(absolute, relative, { mode: info.mode });
    added += 1;
    onProgress?.({ current: added, total: uniquePaths.length, path: relative });
  }
  if (commitMessage?.trim()) {
    zip.addBuffer(Buffer.from(`${commitMessage.trim()}\n`, 'utf8'), '.zipflow/commit-message.txt');
  }
  const completed = pipeArchive(zip, absoluteOutput);
  zip.end();
  await completed;
  const archiveStat = await stat(absoluteOutput);
  return { outputPath: absoluteOutput, fileCount: added, size: archiveStat.size };
}

function pipeArchive(zip, outputPath) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath, { flags: 'w' });
    output.on('close', resolve);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
  });
}

function relativeInside(root, target) {
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return normalizeRelativePath(relative);
}
