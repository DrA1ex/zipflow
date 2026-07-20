import path from 'node:path';
import { walkFiles } from '../utils/fs.js';
import { createPathMatcher, normalizeRelativePath } from '../plan/matcher.js';
import { createRootGitignoreMatcher } from '../git/ignore.js';
import { listIgnoredPaths } from '../git/repository.js';
import { isProtectedProjectPath } from '../archive/protected.js';
import { createLocalCompletion } from './client.js';
import { promptLanguage, promptLanguageDirective, summaryLanguage } from './language.js';
import { resolveLocalLlmSession } from './session.js';
import { parseAssessmentResponse } from './response.js';
import { createChangeList, createRepresentativePatch } from './delivery.js';
import { fitPatchToBudget } from './patch-budget.js';

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    assessment: { type: 'string', enum: ['suitable', 'suspicious', 'unsuitable'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasons: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
  },
  required: ['assessment', 'confidence', 'reasons'],
};

const MAX_TREE_ENTRIES = 6_000;

export async function reviewArchiveStructure({ settings, project, workflow, extracted, plan }, options = {}) {
  const notify = options.onEvent ?? (() => {});
  notify({ type: 'phase', phase: 'tree-scan', label: 'Comparing project and archive structure' });
  const comparison = await createTreeComparison({ project, workflow, extracted });
  let session = options.session;
  if (!session) {
    session = await resolveLocalLlmSession(settings, {
      fetchImpl: options.fetchImpl, timeoutMs: options.metadataTimeoutMs ?? 10_000, signal: options.signal,
    });
    notify({ type: 'model-profile', profile: session.profile });
  }
  const profile = session.profile;
  const prompt = fitComparison(comparison, profile.contextLength);
  notify({
    type: 'tree-budget',
    originalEntries: comparison.project.entries.length + comparison.archive.entries.length,
    sentEntries: prompt.sentEntries,
    truncated: prompt.truncated,
  });
  const completion = await createLocalCompletion({
    provider: settings.llmProvider,
    model: profile.requestModel,
    loadedModel: profile.loadedModel,
    messages: [
      { role: 'system', content: systemPrompt(promptLanguage(settings), summaryLanguage(settings)) },
      { role: 'user', content: userPrompt(project, plan, prompt.text) },
    ],
    responseSchema: null,
    maxTokens: 512,
    apiToken: session.apiToken,
    contextLength: Math.min(profile.contextLength, 16_384),
    reasoningOffSupported: profile.reasoningOffSupported,
  }, {
    ...options,
    onEvent: (event) => notify({ ...event, stage: 'structure-review' }),
  });
  const parsed = parseArchiveAssessment(completion.content) ?? parseArchiveAssessment(completion.reasoning);
  if (!parsed) {
    const error = new Error('The local model did not return a usable archive-structure assessment.');
    error.code = 'no_archive_assessment';
    error.diagnostics = { completion, profile, tree: prompt };
    throw error;
  }
  return {
    ...parsed,
    diagnostics: {
      profile,
      tree: {
        projectFiles: comparison.project.fileCount,
        archiveFiles: comparison.archive.fileCount,
        originalEntries: comparison.project.entries.length + comparison.archive.entries.length,
        sentEntries: prompt.sentEntries,
        truncated: prompt.truncated,
      },
      finishReason: completion.finishReason,
      usage: completion.usage,
      chunks: completion.chunks,
    },
  };
}

export async function reviewArchiveSample({ settings, project, workflow, extracted, plan, patchContent }, options = {}) {
  const notify = options.onEvent ?? (() => {});
  notify({ type: 'phase', phase: 'sample-guard', label: 'Preparing archive structure and representative patch guard' });
  const comparison = await createTreeComparison({ project, workflow, extracted });
  let session = options.session;
  if (!session) {
    session = await resolveLocalLlmSession(settings, {
      fetchImpl: options.fetchImpl, timeoutMs: options.metadataTimeoutMs ?? 10_000, signal: options.signal,
    });
    notify({ type: 'model-profile', profile: session.profile });
  }
  const profile = session.profile;
  const tree = fitComparison(comparison, Math.min(profile.contextLength, 10_000));
  const sample = createRepresentativePatch(patchContent, { maxFiles: 5 });
  const fitted = fitPatchToBudget(sample.content, Math.max(1_200, Math.min(4_000, Math.floor(profile.contextLength * 0.24))));
  const coverage = {
    ...sample.coverage,
    patchCoveragePercent: Math.min(sample.coverage.patchCoveragePercent, fitted.originalEstimatedTokens
      ? Math.round(fitted.sentEstimatedTokens / fitted.originalEstimatedTokens * sample.coverage.patchCoveragePercent)
      : sample.coverage.patchCoveragePercent),
  };
  notify({
    type: 'tree-budget',
    originalEntries: comparison.project.entries.length + comparison.archive.entries.length,
    sentEntries: tree.sentEntries,
    truncated: tree.truncated,
  });
  notify({ type: 'coverage', ...coverage });
  const completion = await createLocalCompletion({
    provider: settings.llmProvider,
    model: profile.requestModel,
    loadedModel: profile.loadedModel,
    messages: [
      { role: 'system', content: `${systemPrompt(promptLanguage(settings), summaryLanguage(settings))} The patch excerpts are a bounded representative sample, so do not imply that every changed file was read.` },
      { role: 'user', content: sampleUserPrompt(project, plan, tree.text, fitted.content, coverage) },
    ],
    responseSchema: null,
    maxTokens: 512,
    apiToken: session.apiToken,
    contextLength: Math.min(profile.contextLength, 16_384),
    reasoningOffSupported: profile.reasoningOffSupported,
  }, {
    ...options,
    onEvent: (event) => notify({ ...event, stage: 'sample-guard' }),
  });
  const parsed = parseArchiveAssessment(completion.content) ?? parseArchiveAssessment(completion.reasoning);
  if (!parsed) {
    const error = new Error('The local model did not return a usable archive sample assessment.');
    error.code = 'no_archive_assessment';
    error.diagnostics = { completion, profile, tree, coverage };
    throw error;
  }
  return {
    ...parsed,
    diagnostics: {
      profile,
      tree: {
        projectFiles: comparison.project.fileCount,
        archiveFiles: comparison.archive.fileCount,
        originalEntries: comparison.project.entries.length + comparison.archive.entries.length,
        sentEntries: tree.sentEntries,
        truncated: tree.truncated,
      },
      coverage,
      patch: fitted,
      finishReason: completion.finishReason,
      usage: completion.usage,
      chunks: completion.chunks,
    },
  };
}

export async function createTreeComparison({ project, workflow, extracted }) {
  const excluded = createPathMatcher(workflow.exclude);
  const projectFiles = (await walkFiles(project.root, {
    include: (relative) => !excluded(relative) && !isProtectedProjectPath(relative),
    descend: (relative) => !excluded(relative) && !isProtectedProjectPath(relative),
  })).map(normalizeRelativePath).filter(Boolean);
  const ignored = await ignoredProjectPaths(project, projectFiles);
  const visibleProjectFiles = projectFiles.filter((relative) => !ignored.has(relative));
  const archiveFiles = extracted.entries
    .map((entry) => normalizeRelativePath(entry.relativePath))
    .filter((relative) => relative && !excluded(relative) && !isProtectedProjectPath(relative));
  return {
    project: treeRecord(visibleProjectFiles),
    archive: treeRecord(archiveFiles),
  };
}

export function parseArchiveAssessment(content) {
  return parseAssessmentResponse(content);
}

function treeRecord(files) {
  const normalized = [...new Set(files)].sort();
  const directories = new Set();
  for (const file of normalized) {
    let current = path.posix.dirname(file);
    while (current && current !== '.') {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  const entries = [
    ...[...directories].sort().map((value) => `D ${value}/`),
    ...normalized.map((value) => `F ${value}`),
  ];
  return {
    fileCount: normalized.length,
    directoryCount: directories.size,
    topLevel: [...new Set(normalized.map((value) => value.split('/')[0]))].sort(),
    entries,
  };
}

async function ignoredProjectPaths(project, files) {
  if (!files.length) return new Set();
  if (project.git) return listIgnoredPaths(project.root, files, { includeTracked: true });
  const matcher = await createRootGitignoreMatcher(project.root);
  return new Set(files.filter((relative) => matcher(relative)));
}

function fitComparison(comparison, contextLength) {
  const maxChars = Math.max(12_000, Math.min(180_000, Math.floor(contextLength * 2.7)));
  const projectHeader = treeHeader('CURRENT PROJECT', comparison.project);
  const archiveHeader = treeHeader('ARCHIVE', comparison.archive);
  const available = Math.max(2_000, maxChars - projectHeader.length - archiveHeader.length - 200);
  const projectBudget = Math.floor(available / 2);
  const archiveBudget = available - projectBudget;
  const project = fitEntries(comparison.project.entries, projectBudget);
  const archive = fitEntries(comparison.archive.entries, archiveBudget);
  return {
    text: [projectHeader, ...project.lines, '', archiveHeader, ...archive.lines].join('\n'),
    sentEntries: project.lines.length + archive.lines.length,
    truncated: project.truncated || archive.truncated,
  };
}

function fitEntries(entries, maxChars) {
  const source = entries.slice(0, MAX_TREE_ENTRIES);
  const lines = [];
  let size = 0;
  for (const entry of prioritize(source)) {
    const next = entry.length + 1;
    if (size + next > maxChars) break;
    lines.push(entry);
    size += next;
  }
  const includedCount = lines.length;
  const truncated = includedCount < entries.length;
  if (truncated) lines.push(`… ${entries.length - includedCount} additional entries omitted`);
  return { lines, truncated };
}

function prioritize(entries) {
  return [...entries].sort((left, right) => depth(left) - depth(right) || left.localeCompare(right));
}

function depth(entry) {
  return String(entry).replace(/^[DF]\s+/, '').split('/').filter(Boolean).length;
}

function treeHeader(label, record) {
  return `${label}: ${record.fileCount} files · ${record.directoryCount} directories\nTop level: ${record.topLevel.join(', ') || '(empty)'}`;
}

function systemPrompt(promptLang, outputLanguage) {
  return [
    promptLanguageDirective(promptLang),
    'You are a conservative archive-suitability reviewer for a local source-code update tool.',
    'Compare the current project tree with the incoming archive tree and decide whether the archive plausibly belongs to this project.',
    'Do not reject an archive merely because generated, ignored, cache, environment, build, or dependency files are missing.',
    'Use unsuitable only for a strong mismatch such as unrelated project markers, a different product layout, or a snapshot missing most expected source areas.',
    'Use suspicious when the evidence is ambiguous or the archive may be partial in a risky way.',
    'Return plain text, not JSON or Markdown fences, using exactly these headings:',
    'ASSESSMENT: followed by suitable, suspicious, or unsuitable.',
    'CONFIDENCE: followed by low, medium, or high.',
    'REASONS: followed by one to five concise bullet points.',
    `Write reasons in ${outputLanguage}; assessment and confidence remain English enum values.`,
  ].join(' ');
}

function userPrompt(project, plan, treeText) {
  return [
    `Expected project: ${project.name}`,
    `Detected technologies: ${(project.labels ?? []).join(', ') || 'unknown'}`,
    `Planned changes: created=${plan.counts.created}, updated=${plan.counts.updated}, deleted=${plan.counts.deleted}, unchanged=${plan.counts.unchanged}`,
    '', treeText,
  ].join('\n');
}

function sampleUserPrompt(project, plan, treeText, patchText, coverage) {
  return [
    userPrompt(project, plan, treeText),
    '', 'COMPLETE CHANGED PATH MANIFEST:', createChangeList(plan),
    '', `REPRESENTATIVE PATCH SAMPLE: ${coverage.reviewedFiles} of ${coverage.totalFiles} changed files include content.`,
    'Do not infer unseen implementation details from omitted files.',
    '', 'PATCH SAMPLE START', patchText || '(no patch excerpts available)', 'PATCH SAMPLE END',
  ].join('\n');
}

function clean(value) {
  return String(value ?? '').trim().replace(/^[-*•]\s+/, '');
}
