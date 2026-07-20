const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/m;
const DEFAULT_BATCH_TOKENS = 4_000;
const IMPORTANT_NAMES = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|requirements[^/]*\.txt|cargo\.toml|go\.mod|dockerfile|compose[^/]*\.ya?ml|makefile|readme[^/]*|.*config[^/]*|.*\.config\.[^/]+|.*migration[^/]*)$/i;
const GENERATED_NAMES = /(^|\/)(dist|build|coverage|node_modules|vendor|target|\.cache)(\/|$)|\.(min\.js|map|lock)$/i;

export function resolveDeliveryMode(requested, { patchEstimatedTokens = 0, patchBudgetTokens = 0, fileCount = 0 } = {}) {
  if (requested && requested !== 'adaptive') return requested;
  if (!patchEstimatedTokens) return 'change-list';
  const safeBudget = Math.max(1_000, Math.floor(patchBudgetTokens * 0.8));
  if (patchEstimatedTokens <= safeBudget) return 'patch';
  if (patchEstimatedTokens <= Math.max(safeBudget * 3, 12_000) || fileCount <= 40) return 'representative';
  return 'capped';
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

export function selectRepresentativeSections(patchContent, { maxFiles = 8 } = {}) {
  const sections = splitPatchByFile(patchContent);
  if (sections.length <= maxFiles) return sections;
  const ranked = sections.map((section, index) => ({ section, index, score: representativeScore(section) }))
    .sort((left, right) => right.score - left.score || left.section.path.localeCompare(right.section.path) || left.index - right.index);
  const selected = [];
  const topLevels = new Set();
  for (const candidate of ranked) {
    const top = candidate.section.path.split('/')[0];
    if (!topLevels.has(top) && selected.length < maxFiles) {
      selected.push(candidate);
      topLevels.add(top);
    }
  }
  for (const candidate of ranked) {
    if (selected.length >= maxFiles) break;
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return selected.sort((left, right) => left.index - right.index).map((item) => item.section);
}

export function createRepresentativePatch(patchContent, { maxFiles = 8 } = {}) {
  const all = splitPatchByFile(patchContent);
  const selected = selectRepresentativeSections(patchContent, { maxFiles });
  const content = selected.map((item) => item.content).join('\n\n');
  return {
    sections: selected,
    content,
    coverage: coverageRecord(all, selected, patchContent, content),
  };
}

export function createCappedPatchBatches(patchContent, {
  maxBatches = 3,
  maxFiles = 12,
  maxEstimatedTokens = DEFAULT_BATCH_TOKENS,
  maxFilesPerBatch = 4,
} = {}) {
  const all = splitPatchByFile(patchContent);
  const selected = selectRepresentativeSections(patchContent, { maxFiles });
  const selectedContent = selected.map((item) => item.content).join('\n\n');
  const batches = createPatchBatches(selectedContent, {
    maxEstimatedTokens,
    maxFiles: maxFilesPerBatch,
  }).slice(0, maxBatches);
  const includedFiles = new Set(batches.flatMap((batch) => batch.files));
  const included = selected.filter((section) => includedFiles.has(section.path));
  return {
    batches,
    coverage: coverageRecord(all, included, patchContent, batches.map((batch) => batch.content).join('\n\n')),
  };
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

function representativeScore(section) {
  let score = 0;
  if (/deleted file mode|^--- a\/.+\n\+\+\+ \/dev\/null/m.test(section.content)) score += 100;
  if (/new file mode|^--- \/dev\/null\n\+\+\+ b\//m.test(section.content)) score += 55;
  if (IMPORTANT_NAMES.test(section.path)) score += 75;
  if (/(^|\/)(src|sources|app|lib|server|client|api|migrations?)\//i.test(section.path)) score += 35;
  if (/(^|\/)(index|main|app|server|cli)\.[^/]+$/i.test(section.path)) score += 30;
  if (GENERATED_NAMES.test(section.path)) score -= 70;
  score += Math.min(25, Math.floor(estimateTokens(section.content) / 300));
  return score;
}

function coverageRecord(all, selected, fullContent, selectedContent) {
  const totalChars = Math.max(1, String(fullContent ?? '').length);
  return {
    reviewedFiles: selected.length,
    totalFiles: all.length,
    manifestFiles: all.length,
    omittedFiles: Math.max(0, all.length - selected.length),
    patchCoveragePercent: Math.max(0, Math.min(100, Math.round(String(selectedContent ?? '').length / totalChars * 100))),
    reviewedPaths: selected.map((item) => item.path),
  };
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
