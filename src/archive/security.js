import path from 'node:path';

export const DEFAULT_ARCHIVE_LIMITS = {
  maxFiles: 20_000,
  maxTotalSize: 2 * 1024 * 1024 * 1024,
  maxFileSize: 256 * 1024 * 1024,
  maxCompressionRatio: 1_000,
  maxPathLength: 1_024,
  maxPathDepth: 64,
};

export function validateZipEntry(entry, limits = DEFAULT_ARCHIVE_LIMITS) {
  const original = String(entry.fileName ?? '');
  if (!original || original.includes('\0')) throw archiveError('Archive contains an invalid empty path.');
  if (original.includes('\\')) throw archiveError(`Archive path uses ambiguous backslash separators: ${original}`);
  if (original.startsWith('/') || /^[A-Za-z]:/.test(original) || original.startsWith('//')) {
    throw archiveError(`Archive contains an absolute path: ${original}`);
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw archiveError(`Encrypted ZIP entries are not supported: ${original}`);
  if (/[\u0000-\u001f\u007f]/.test(original)) throw archiveError(`Archive path contains control characters: ${JSON.stringify(original)}`);
  const trailingSlash = original.endsWith('/');
  const rawSegments = original.split('/');
  const contentSegments = trailingSlash ? rawSegments.slice(0, -1) : rawSegments;
  if (!contentSegments.length || contentSegments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw archiveError(`Archive path escapes the project or is ambiguous: ${original}`);
  }
  for (const segment of contentSegments) validatePortableSegment(segment, original);
  const normalized = path.posix.normalize(original).replace(/\/$/, '').normalize('NFC');
  if (normalized.length > limits.maxPathLength) throw archiveError(`Archive path is too long: ${original}`);
  const segments = normalized.split('/');
  if (segments.length > limits.maxPathDepth) throw archiveError(`Archive path is too deeply nested: ${original}`);
  if (segments.some((segment) => segment.normalize('NFKC').toLocaleLowerCase('en-US') === '.git')) {
    throw archiveError(`Archive is not allowed to modify .git: ${original}`);
  }

  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  const isDirectoryType = fileType === 0o040000;
  const isRegularType = fileType === 0o100000;
  const isSymlinkType = fileType === 0o120000;
  if (isSymlinkType) throw archiveError(`Symbolic links are not supported: ${original}`);
  if (fileType && !isDirectoryType && !isRegularType) {
    throw archiveError(`Archive contains an unsupported special file: ${original}`);
  }
  if (trailingSlash && fileType && !isDirectoryType) throw archiveError(`Archive directory has an invalid file type: ${original}`);
  if (!trailingSlash && isDirectoryType) throw archiveError(`Archive file has an invalid directory type: ${original}`);
  if (trailingSlash && entry.uncompressedSize !== 0) throw archiveError(`Archive directory contains file data: ${original}`);
  if (entry.uncompressedSize > limits.maxFileSize) throw archiveError(`Archive entry is too large: ${original}`);
  if (entry.compressedSize > 0 && entry.uncompressedSize > 1024 * 1024) {
    const ratio = entry.uncompressedSize / entry.compressedSize;
    if (ratio > limits.maxCompressionRatio) throw archiveError(`Suspicious compression ratio for ${original}`);
  }
  return {
    path: normalized,
    collisionKey: normalized.normalize('NFKC').toLocaleLowerCase('en-US'),
    directory: trailingSlash,
    mode: unixMode & 0o777,
    skip: segments[0] === '__MACOSX',
  };
}


function validatePortableSegment(segment, original) {
  if (segment.endsWith(' ') || segment.endsWith('.')) {
    throw archiveError(`Archive path has a platform-ambiguous trailing character: ${original}`);
  }
  if (segment.includes(':')) throw archiveError(`Archive path uses an alternate-stream or drive separator: ${original}`);
  if (Buffer.byteLength(segment, 'utf8') > 255) throw archiveError(`Archive path segment is too long: ${original}`);
  const stem = segment.split('.', 1)[0].normalize('NFKC').toLocaleUpperCase('en-US');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw archiveError(`Archive path uses a reserved device name: ${original}`);
  }
}

function archiveError(message) {
  const error = new Error(message);
  error.code = 'unsafe_archive';
  return error;
}
