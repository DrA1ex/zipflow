import path from 'node:path';

export const DEFAULT_ARCHIVE_LIMITS = {
  maxFiles: 20_000,
  maxTotalSize: 2 * 1024 * 1024 * 1024,
  maxFileSize: 256 * 1024 * 1024,
  maxCompressionRatio: 1_000,
};

export function validateZipEntry(entry, limits = DEFAULT_ARCHIVE_LIMITS) {
  const raw = String(entry.fileName ?? '').replaceAll('\\', '/');
  if (!raw || raw.includes('\0')) throw new Error('Archive contains an invalid empty path.');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error(`Archive contains an absolute path: ${raw}`);
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`Archive path escapes the project: ${raw}`);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.includes('.git')) throw new Error(`Archive is not allowed to modify .git: ${raw}`);
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if ((mode & 0o170000) === 0o120000) throw new Error(`Symbolic links are not supported: ${raw}`);
  if (entry.uncompressedSize > limits.maxFileSize) throw new Error(`Archive entry is too large: ${raw}`);
  if (entry.compressedSize > 0 && entry.uncompressedSize > 1024 * 1024) {
    const ratio = entry.uncompressedSize / entry.compressedSize;
    if (ratio > limits.maxCompressionRatio) throw new Error(`Suspicious compression ratio for ${raw}`);
  }
  return {
    path: normalized.replace(/\/$/, ''),
    directory: raw.endsWith('/'),
    mode: mode & 0o777,
    skip: segments[0] === '__MACOSX' || segments.at(-1) === '.DS_Store',
  };
}
