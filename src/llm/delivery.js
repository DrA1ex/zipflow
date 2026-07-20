const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/m;
const DEFAULT_BATCH_TOKENS = 4_000;

export function resolveDeliveryMode(requested, { patchEstimatedTokens = 0, patchBudgetTokens = 0 } = {}) {
  if (requested && requested !== 'adaptive') return requested;
  if (!patchEstimatedTokens) return 'change-list';
  return patchEstimatedTokens <= Math.max(1_000, Math.floor(patchBudgetTokens * 0.8)) ? 'patch' : 'chunked';
}

export function createChangeList(plan, { limit = 8_000 } = {}) {
  const values = [
    ...(plan.created ?? []).map((item) => `CREATE ${item.path}`),
    ...(plan.updated ?? []).map((item) => `UPDATE ${item.path}`),
    ...(plan.deleted ?? []).map((item) => `DELETE ${item.path}`),
  ];
  const lines = [
    `Created: ${plan.created?.length ?? 0}`,
    `Updated: ${plan.updated?.length ?? 0}`,
    `Deleted: ${plan.deleted?.length ?? 0}`,
    '',
    ...values.slice(0, limit),
  ];
  if (!values.length) lines.push('(none)');
  if (values.length > limit) lines.push(`… ${values.length - limit} additional changed paths omitted`);
  return lines.join('\n').trimEnd();
}

export function splitPatchByFile(patchContent) {
  const source = String(patchContent ?? '').replace(/\r\n/g, '\n');
  const starts = [];
  const expression = /^diff --git a\/.+? b\/.+$/gm;
  let match;
  while ((match = expression.exec(source))) starts.push(match.index);
  if (!starts.length) return source.trim() ? [{ path: '(changes.patch)', content: source }] : [];
  return starts.map((start, index) => {
    const content = source.slice(start, starts[index + 1] ?? source.length).trimEnd();
    const header = FILE_HEADER.exec(content);
    return { path: header?.[2] ?? header?.[1] ?? `(file ${index + 1})`, content };
  });
}

export function createPatchBatches(patchContent, {
  maxEstimatedTokens = DEFAULT_BATCH_TOKENS,
  maxFiles = 8,
} = {}) {
  const sections = splitPatchByFile(patchContent);
  const batches = [];
  let current = [];
  let tokens = 0;
  for (const section of sections) {
    const sectionTokens = estimateTokens(section.content);
    if (current.length && (tokens + sectionTokens > maxEstimatedTokens || current.length >= maxFiles)) {
      batches.push(batchRecord(current, tokens));
      current = [];
      tokens = 0;
    }
    if (sectionTokens > maxEstimatedTokens) {
      const chunks = chunkLargeSection(section, maxEstimatedTokens);
      for (const chunk of chunks) batches.push(batchRecord([chunk], estimateTokens(chunk.content)));
      continue;
    }
    current.push(section);
    tokens += sectionTokens;
  }
  if (current.length) batches.push(batchRecord(current, tokens));
  return batches;
}

export function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value ?? '').length / 3.5));
}

function batchRecord(sections, estimatedTokens) {
  return {
    index: 0,
    files: sections.map((item) => item.path),
    content: sections.map((item) => item.content).join('\n\n'),
    estimatedTokens,
  };
}

function chunkLargeSection(section, maxEstimatedTokens) {
  const maxChars = Math.max(2_000, Math.floor(maxEstimatedTokens * 3.5));
  const lines = section.content.split('\n');
  const header = lines.slice(0, Math.min(lines.length, 4)).join('\n');
  const body = lines.slice(Math.min(lines.length, 4));
  const chunks = [];
  let current = [];
  let size = header.length + 1;
  for (const line of body) {
    if (current.length && size + line.length + 1 > maxChars) {
      chunks.push({ path: section.path, content: `${header}\n# Continued patch excerpt\n${current.join('\n')}` });
      current = [];
      size = header.length + 26;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length || !chunks.length) chunks.push({ path: section.path, content: `${header}\n${current.join('\n')}` });
  return chunks;
}
