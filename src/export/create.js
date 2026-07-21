import path from 'node:path';
import { lstat, rename, rm, stat } from 'node:fs/promises';
import yazl from 'yazl';
import { normalizeRelativePath } from '../plan/matcher.js';
import { assertSafeProjectPath } from '../security/project-path.js';
import { throwIfCancelled } from '../operations/manager.js';
import { assertSafeOutputLeaf, prepareSafeOutputPath } from '../security/output-path.js';
import { createExclusiveWriteStream } from '../security/safe-file.js';
import { shortToken } from '../utils/hash.js';

export async function createProjectArchive({ projectRoot, paths, outputPath, commitMessage = null, onProgress = null, signal = null }) {
  const preparedOutput = await prepareSafeOutputPath(outputPath);
  const absoluteOutput = preparedOutput.target;
  const outputRelative = relativeInside(projectRoot, absoluteOutput);
  const uniquePaths = [...new Set(paths.map(normalizeRelativePath))]
    .filter((relative) => relative && relative !== outputRelative)
    .sort();
  if (!uniquePaths.length) throw new Error('No files were selected for the ZIP archive.');
  const zip = new yazl.ZipFile();
  let added = 0;
  for (const relative of uniquePaths) {
    throwIfCancelled(signal);
    const { target: absolute } = await assertSafeProjectPath(projectRoot, relative, { allowMissingLeaf: false, requireFile: true });
    const info = await stat(absolute);
    if (!info.isFile()) continue;
    zip.addFile(absolute, relative, { mode: info.mode });
    added += 1;
    onProgress?.({ current: added, total: uniquePaths.length, path: relative });
  }
  if (commitMessage?.trim()) {
    zip.addBuffer(Buffer.from(`${commitMessage.trim()}\n`, 'utf8'), '.zipflow/commit-message.txt');
  }
  const temporaryOutput = path.join(preparedOutput.parent, `.${path.basename(absoluteOutput)}.zipflow-${process.pid}-${shortToken(8)}.tmp`);
  const completed = pipeArchive(zip, temporaryOutput, signal);
  zip.end();
  try {
    await completed;
    await assertSafeOutputLeaf(absoluteOutput);
    await replaceOutputFile(temporaryOutput, absoluteOutput);
  } catch (error) {
    await rm(temporaryOutput, { force: true }).catch(() => {});
    throw error;
  }
  const archiveStat = await stat(absoluteOutput);
  return { outputPath: absoluteOutput, fileCount: added, size: archiveStat.size };
}


async function replaceOutputFile(temporary, target) {
  try {
    await rename(temporary, target);
    return;
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
  }
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) {
    const error = new Error('The output ZIP path changed into an unsafe filesystem object before it could be replaced.');
    error.code = 'unsafe_output_path';
    throw error;
  }
  await rm(target, { force: true });
  await rename(temporary, target);
}

function pipeArchive(zip, outputPath, signal = null) {
  return new Promise((resolve, reject) => {
    const output = createExclusiveWriteStream(outputPath, { mode: 0o600 });
    const abort = () => output.destroy(Object.assign(new Error('Operation cancelled.'), { code: 'cancelled' }));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    output.on('close', () => { signal?.removeEventListener('abort', abort); resolve(); });
    output.on('error', (error) => { signal?.removeEventListener('abort', abort); reject(error); });
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
  });
}

function relativeInside(root, target) {
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return normalizeRelativePath(relative);
}
