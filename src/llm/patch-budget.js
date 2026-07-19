const CHARS_PER_TOKEN = 3;
const SAFE_CONTEXT_CAP = 16_384;
const OUTPUT_RESERVE = 1_024;
const SAFETY_RESERVE = 1_024;
const MIN_PATCH_TOKENS = 1_024;

export function createPromptBudget({ contextLength, fixedPrompt = '', requestedOutputTokens = OUTPUT_RESERVE }) {
  const detected = positiveInteger(contextLength) ?? SAFE_CONTEXT_CAP;
  const effectiveContext = Math.min(detected, SAFE_CONTEXT_CAP);
  const fixedTokens = estimateTokens(fixedPrompt);
  const outputTokens = Math.min(requestedOutputTokens, Math.max(256, Math.floor(effectiveContext / 4)));
  const patchTokens = Math.max(MIN_PATCH_TOKENS, effectiveContext - fixedTokens - outputTokens - SAFETY_RESERVE);
  return {
    detectedContextTokens: detected,
    effectiveContextTokens: effectiveContext,
    fixedPromptTokens: fixedTokens,
    outputTokens,
    patchTokens,
  };
}

export function fitPatchToBudget(patchContent, maxTokens) {
  const source = String(patchContent ?? '');
  const originalEstimatedTokens = estimateTokens(source);
  if (originalEstimatedTokens <= maxTokens) {
    return {
      content: source,
      truncated: false,
      originalEstimatedTokens,
      sentEstimatedTokens: originalEstimatedTokens,
      includedFiles: countFiles(source),
      omittedFiles: 0,
      omittedHunks: 0,
    };
  }

  const sections = splitPatchSections(source);
  if (!sections.length) return fallbackTruncate(source, maxTokens);
  const manifest = buildManifest(sections);
  const selected = sections.map((section) => ({ header: section.header, hunks: [] }));
  let content = `${manifest}\n\n${renderSections(selected)}`;
  let remaining = maxTokens - estimateTokens(content);
  let omittedHunks = sections.reduce((sum, section) => sum + section.hunks.length, 0);

  for (let round = 0; remaining > 0; round += 1) {
    let added = false;
    for (let index = 0; index < sections.length; index += 1) {
      const hunk = sections[index].hunks[round];
      if (!hunk) continue;
      const cost = estimateTokens(`\n${hunk}`);
      if (cost <= remaining) {
        selected[index].hunks.push(hunk);
        remaining -= cost;
        omittedHunks -= 1;
        added = true;
      } else if (round === 0 && remaining >= 120) {
        const excerpt = excerptHunk(hunk, remaining);
        if (excerpt) {
          selected[index].hunks.push(excerpt);
          remaining -= estimateTokens(`\n${excerpt}`);
          omittedHunks -= 1;
          added = true;
        }
      }
    }
    if (!added || round > 10_000) break;
  }

  content = [
    manifest,
    '',
    renderSections(selected),
    '',
    `# Zipflow omitted ${Math.max(0, omittedHunks)} additional diff hunks to fit the local model context safely.`,
  ].join('\n').trim();
  const sentEstimatedTokens = estimateTokens(content);
  return {
    content,
    truncated: true,
    originalEstimatedTokens,
    sentEstimatedTokens,
    includedFiles: selected.filter((section) => section.hunks.length).length,
    omittedFiles: selected.filter((section) => !section.hunks.length).length,
    omittedHunks: Math.max(0, omittedHunks),
  };
}

export function reducePatchBudget(currentTokens, reason = 'retry') {
  const factor = reason === 'out_of_memory' ? 0.45 : 0.65;
  return Math.max(MIN_PATCH_TOKENS, Math.floor(currentTokens * factor));
}

export function estimateTokens(value) {
  return Math.max(0, Math.ceil(String(value ?? '').length / CHARS_PER_TOKEN));
}

function splitPatchSections(source) {
  const starts = [];
  const pattern = /^diff --git .+$/gm;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) starts.push(match.index);
  if (!starts.length) return [];
  return starts.map((start, index) => parseSection(source.slice(start, starts[index + 1] ?? source.length)));
}

function parseSection(source) {
  const hunkStarts = [];
  const pattern = /^@@ .+@@.*$/gm;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) hunkStarts.push(match.index);
  if (!hunkStarts.length) return { header: source.trimEnd(), hunks: [] };
  return {
    header: source.slice(0, hunkStarts[0]).trimEnd(),
    hunks: hunkStarts.map((start, index) => source.slice(start, hunkStarts[index + 1] ?? source.length).trimEnd()),
  };
}

function buildManifest(sections) {
  const files = sections.map((section) => {
    const line = section.header.split('\n')[0] ?? '';
    return line.replace(/^diff --git a\//, '').replace(/ b\/.+$/, '');
  });
  return ['# Complete changed-file manifest', ...files.map((file) => `# - ${file}`)].join('\n');
}

function renderSections(sections) {
  return sections.map((section) => [section.header, ...section.hunks].filter(Boolean).join('\n')).join('\n\n');
}

function excerptHunk(hunk, tokenBudget) {
  const charBudget = Math.max(0, tokenBudget * CHARS_PER_TOKEN - 100);
  if (charBudget < 200) return '';
  const lines = hunk.split('\n');
  const header = lines.shift() ?? '';
  const body = lines.join('\n');
  if (body.length <= charBudget) return hunk;
  const side = Math.max(60, Math.floor((charBudget - 80) / 2));
  return `${header}\n${body.slice(0, side)}\n# ... hunk excerpt shortened by Zipflow ...\n${body.slice(-side)}`;
}

function fallbackTruncate(source, maxTokens) {
  const chars = Math.max(512, maxTokens * CHARS_PER_TOKEN);
  const side = Math.floor((chars - 100) / 2);
  const content = `${source.slice(0, side)}\n\n# ... patch shortened by Zipflow ...\n\n${source.slice(-side)}`;
  return {
    content,
    truncated: true,
    originalEstimatedTokens: estimateTokens(source),
    sentEstimatedTokens: estimateTokens(content),
    includedFiles: countFiles(content),
    omittedFiles: 0,
    omittedHunks: 0,
  };
}

function countFiles(source) {
  return (String(source).match(/^diff --git /gm) ?? []).length;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}
