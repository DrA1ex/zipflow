import path from 'node:path';
import { lstat, realpath, stat } from 'node:fs/promises';

export async function inspectArchiveFile(archivePath) {
  const lexical = path.resolve(archivePath);
  const linkInfo = await lstat(lexical);
  if (linkInfo.isSymbolicLink()) throw unsafeArchiveInput('The selected ZIP path is a symbolic link. Choose the real archive file instead.');
  if (!linkInfo.isFile()) throw unsafeArchiveInput('Archive path is not a regular file.');
  const canonical = await realpath(lexical);
  if (canonical !== lexical) throw unsafeArchiveInput('The selected ZIP path resolves through a filesystem alias. Choose the canonical archive path instead.');
  const fileInfo = await stat(canonical);
  if (!fileInfo.isFile()) throw unsafeArchiveInput('Archive path is not a regular file.');
  return { path: canonical, size: fileInfo.size, modifiedAt: fileInfo.mtime.toISOString() };
}

function unsafeArchiveInput(message) {
  const error = new Error(message);
  error.code = 'unsafe_archive_input';
  return error;
}
