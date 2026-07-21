import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { cancelledError } from '../operations/manager.js';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export async function assertRegularFileNoFollow(target, label = 'File') {
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw unsafeFile(`${label} is a symbolic link: ${target}`);
  if (!info.isFile()) throw unsafeFile(`${label} is not a regular file: ${target}`);
  return info;
}

export async function copyRegularFileNoFollow(source, target, {
  mode = 0o600,
  signal = null,
  sourceLabel = 'Source file',
} = {}) {
  await assertRegularFileNoFollow(source, sourceLabel);
  const readFlags = constants.O_RDONLY | NOFOLLOW;
  const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
  const input = createReadStream(source, { flags: readFlags });
  const output = createWriteStream(target, { flags: writeFlags, mode });
  try {
    if (signal) await pipeline(input, output, { signal });
    else await pipeline(input, output);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw cancelledError();
    throw error;
  }
  return target;
}

export function createExclusiveWriteStream(target, { mode = 0o600 } = {}) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
  return createWriteStream(target, { flags, mode });
}

function unsafeFile(message) {
  const error = new Error(message);
  error.code = 'unsafe_file';
  return error;
}
