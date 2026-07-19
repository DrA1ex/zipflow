import { readFile } from 'node:fs/promises';

const COMMIT_MESSAGE_FILES = [
  '.zipflow/commit-message.txt',
  '.zipflow/commit_message.txt',
  '.commit_message',
  '.commit_message.txt',
  'commit_message.txt',
  'COMMIT_MESSAGE',
  'COMMIT_MESSAGE.txt',
];

const COMMIT_MESSAGE_LOOKUP = new Map(COMMIT_MESSAGE_FILES.map((name, index) => [name.toLowerCase(), index]));

export async function readArchiveMetadata(extracted, { maxMessageBytes = 16 * 1024 } = {}) {
  const candidates = extracted.entries
    .filter((entry) => COMMIT_MESSAGE_LOOKUP.has(entry.relativePath.toLowerCase()))
    .sort((left, right) => COMMIT_MESSAGE_LOOKUP.get(left.relativePath.toLowerCase()) - COMMIT_MESSAGE_LOOKUP.get(right.relativePath.toLowerCase()));
  if (!candidates.length) return { commitMessage: null, commitMessageSource: null, controlPaths: [] };
  const selected = candidates[0];
  if (selected.size > maxMessageBytes) throw new Error(`Archive commit message is too large: ${selected.relativePath}`);
  const commitMessage = (await readFile(selected.absolutePath, 'utf8')).trim();
  if (!commitMessage) throw new Error(`Archive commit message is empty: ${selected.relativePath}`);
  return {
    commitMessage,
    commitMessageSource: selected.relativePath,
    controlPaths: candidates.map((entry) => entry.relativePath),
  };
}

export function isArchiveControlPath(relativePath) {
  return COMMIT_MESSAGE_LOOKUP.has(String(relativePath).toLowerCase());
}

export function commitMessageFileNames() {
  return [...COMMIT_MESSAGE_FILES];
}
