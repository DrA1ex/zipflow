import path from 'node:path';
import { lstat, mkdir, realpath } from 'node:fs/promises';

export async function prepareSafeOutputPath(outputPath) {
  const lexical = path.resolve(outputPath);
  const parent = path.dirname(lexical);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  const target = path.join(canonicalParent, path.basename(lexical));
  await assertSafeOutputLeaf(target);
  return { lexical, parent: canonicalParent, target };
}

export async function assertSafeOutputLeaf(target) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw unsafeOutput('The output ZIP path is a symbolic link. Choose a regular file path instead.');
    if (!info.isFile()) throw unsafeOutput('The output ZIP path exists but is not a regular file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return true;
}

function unsafeOutput(message) {
  const error = new Error(message);
  error.code = 'unsafe_output_path';
  return error;
}
