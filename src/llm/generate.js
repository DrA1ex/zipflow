import { createLocalCompletion } from './client.js';

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: {
      type: 'array', minItems: 1, maxItems: 5,
      items: { type: 'string' },
    },
    commitMessage: { type: 'string', minLength: 1 },
  },
  required: ['summary', 'commitMessage'],
};

const MAX_PROMPT_PATCH_CHARS = 220_000;
const MAX_REPAIR_DRAFT_CHARS = 40_000;

export function isLocalLlmEnabled(settings) {
  return ['ollama', 'lmstudio'].includes(settings?.llmProvider) && Boolean(settings?.llmModel);
}

export async function generateChangeDescription({ settings, project, plan, patchContent }, options = {}) {
  if (!isLocalLlmEnabled(settings)) return null;
  const language = settings.llmLanguage || 'English';
  const patch = truncatePatch(patchContent);
  const system = buildSystemPrompt(language);
  const user = [
    `Project: ${project.name}`,
    `Project types: ${(project.labels ?? []).join(', ') || 'unknown'}`,
    `Plan counts: created=${plan.counts.created}, updated=${plan.counts.updated}, deleted=${plan.counts.deleted}`,
    '',
    'PATCH START',
    patch,
    'PATCH END',
  ].join('\n');
  const notify = options.onEvent ?? (() => {});
  notify({ type: 'phase', phase: 'requesting', label: 'Sending patch to the local model' });
  const first = await requestCompletion({ settings, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, {
    ...options,
    onEvent: (event) => notify({ ...event, stage: 'generation' }),
  });
  const direct = tryStructured(first.content) ?? tryStructured(first.reasoning);
  if (direct) return resultWithDiagnostics(direct, first, { repaired: false });

  notify({ type: 'phase', phase: 'repairing', label: 'Formatting the model draft as structured JSON' });
  const draft = [first.content, first.reasoning].filter(Boolean).join('\n\n').slice(-MAX_REPAIR_DRAFT_CHARS);
  if (draft) {
    const repaired = await requestCompletion({
      settings,
      maxTokens: 1_024,
      messages: [
        {
          role: 'system',
          content: [
            'Convert the supplied draft into the required JSON object.',
            'Return JSON only. Do not add analysis, Markdown, or extra keys.',
            `Write summary and commitMessage in ${language}.`,
            'Keep the summary factual and concise. The commit message must be ready for git commit.',
          ].join(' '),
        },
        { role: 'user', content: `DRAFT START\n${draft}\nDRAFT END` },
      ],
    }, {
      ...options,
      onEvent: (event) => notify({ ...event, stage: 'repair' }),
    });
    const parsed = tryStructured(repaired.content) ?? tryStructured(repaired.reasoning);
    if (parsed) return resultWithDiagnostics(parsed, repaired, { repaired: true, originalFinishReason: first.finishReason });
  }

  const partial = extractUnstructured(first.reasoning || first.content);
  if (partial.summary.length) {
    return {
      summary: partial.summary,
      commitMessage: partial.commitMessage,
      warning: partial.commitMessage
        ? 'The local model returned unstructured output; Zipflow extracted the visible summary and commit message.'
        : 'The local model returned unstructured output; Zipflow extracted the summary and will use a commit-message fallback.',
      diagnostics: { finishReason: first.finishReason, chunks: first.chunks, repaired: false, partial: true },
    };
  }
  const suffix = first.finishReason === 'length' ? ' The model reached its output token limit before producing structured JSON.' : '';
  throw new Error(`Local LLM returned no usable structured response.${suffix}`);
}

export function parseResponse(content) {
  const parsed = parseJsonObject(content);
  const summary = normalizeSummary(parsed.summary);
  const commitMessage = normalizeCommitMessage(parsed.commitMessage);
  if (!summary.length || !commitMessage) throw new Error('Local LLM response is missing summary or commitMessage.');
  return { summary, commitMessage };
}

export function extractUnstructured(content) {
  const lines = String(content ?? '').split('\n').map(cleanLine).filter(Boolean);
  const summaryStart = findLastHeading(lines, /^(summary|summary \(.+\)|сводка|краткое описание)\s*:?$/i);
  const source = summaryStart >= 0 ? lines.slice(summaryStart + 1) : lines;
  const summary = [];
  let commitMessage = '';
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    if (/^(commit message|сообщение коммита)(\s*\(.+\))?\s*:?$/i.test(line)) {
      commitMessage = findCommitLine(source.slice(index + 1));
      break;
    }
    if (/^(subject|тема)\s*:/i.test(line)) {
      commitMessage ||= line.replace(/^(subject|тема)\s*:\s*/i, '').trim();
      continue;
    }
    if (summary.length < 5 && isUsefulSummaryLine(line)) summary.push(line);
  }
  return { summary: [...new Set(summary)].slice(0, 5), commitMessage: normalizeCommitMessage(commitMessage) };
}

function buildSystemPrompt(language) {
  return [
    'You analyze source-code patches for a developer workflow tool.',
    'Return only JSON matching the supplied schema. Do not use Markdown fences.',
    'Do not reveal internal reasoning or repeat the patch.',
    `Write both summary and commitMessage in ${language}.`,
    'The summary must contain 1-5 concise factual lines. Mention behavior, architecture, tests, or risks only when visible in the patch.',
    'The commit message must be ready for git commit: imperative subject, preferably under 72 characters, with an optional concise body separated by a blank line.',
    'Do not invent changes, test results, issue numbers, or motivations not supported by the patch.',
  ].join(' ');
}

function requestCompletion({ settings, messages, maxTokens }, options) {
  return createLocalCompletion({
    provider: settings.llmProvider,
    model: settings.llmModel,
    messages,
    responseSchema: RESPONSE_SCHEMA,
    maxTokens,
    apiToken: settings.llmApiToken,
  }, options);
}

function tryStructured(content) {
  try {
    return parseResponse(content);
  } catch {
    return null;
  }
}

function parseJsonObject(content) {
  const source = String(content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Local LLM returned invalid JSON.');
    return JSON.parse(source.slice(start, end + 1));
  }
}

function resultWithDiagnostics(value, completion, extra) {
  return {
    ...value,
    diagnostics: {
      finishReason: completion.finishReason,
      chunks: completion.chunks,
      usage: completion.usage,
      ...extra,
    },
  };
}

function normalizeSummary(value) {
  return Array.isArray(value) ? value.map((line) => String(line).trim()).filter(Boolean).slice(0, 5) : [];
}

function normalizeCommitMessage(value) {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  if (!result || looksLikeJson(result)) return '';
  return result;
}

function looksLikeJson(value) {
  if (!/^[\[{]/.test(value)) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function truncatePatch(value) {
  const patch = String(value ?? '');
  if (patch.length <= MAX_PROMPT_PATCH_CHARS) return patch;
  return `${patch.slice(0, MAX_PROMPT_PATCH_CHARS)}\n\n# Patch truncated by Zipflow before sending to the local LLM.`;
}

function cleanLine(value) {
  return String(value).trim().replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^`+|`+$/g, '').trim();
}

function findLastHeading(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index -= 1) if (pattern.test(lines[index])) return index;
  return -1;
}

function findCommitLine(lines) {
  for (const line of lines) {
    if (/^(subject|тема)\s*:/i.test(line)) return line.replace(/^(subject|тема)\s*:\s*/i, '').trim();
    if (!/^(body|тело)\s*:/i.test(line) && line.length <= 200) return line;
  }
  return '';
}

function isUsefulSummaryLine(line) {
  if (line.length < 8 || line.length > 300) return false;
  if (/^(commit message|subject|body|сообщение коммита|тема|тело)\s*:?/i.test(line)) return false;
  if (/^(summary|сводка)\s*:?$/i.test(line)) return false;
  return true;
}
