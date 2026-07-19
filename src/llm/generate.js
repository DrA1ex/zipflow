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

export function isLocalLlmEnabled(settings) {
  return ['ollama', 'lmstudio'].includes(settings?.llmProvider) && Boolean(settings?.llmModel);
}

export async function generateChangeDescription({ settings, project, plan, patchContent }, options = {}) {
  if (!isLocalLlmEnabled(settings)) return null;
  const language = settings.llmLanguage || 'English';
  const patch = truncatePatch(patchContent);
  const system = [
    'You analyze source-code patches for a developer workflow tool.',
    'Return only JSON matching the supplied schema. Do not use Markdown fences.',
    `Write both summary and commitMessage in ${language}.`,
    'The summary must contain 1-5 concise factual lines. Mention behavior, architecture, tests, or risks only when visible in the patch.',
    'The commit message must be ready for git commit: imperative subject, preferably under 72 characters, with an optional concise body separated by a blank line.',
    'Do not invent changes, test results, issue numbers, or motivations not supported by the patch.',
  ].join(' ');
  const user = [
    `Project: ${project.name}`,
    `Project types: ${(project.labels ?? []).join(', ') || 'unknown'}`,
    `Plan counts: created=${plan.counts.created}, updated=${plan.counts.updated}, deleted=${plan.counts.deleted}`,
    '',
    'PATCH START',
    patch,
    'PATCH END',
  ].join('\n');
  const content = await createLocalCompletion({
    provider: settings.llmProvider,
    model: settings.llmModel,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    responseSchema: RESPONSE_SCHEMA,
  }, options);
  return parseResponse(content);
}

export function parseResponse(content) {
  const source = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Local LLM returned invalid JSON.');
    parsed = JSON.parse(source.slice(start, end + 1));
  }
  const summary = Array.isArray(parsed.summary) ? parsed.summary.map((line) => String(line).trim()).filter(Boolean).slice(0, 5) : [];
  const commitMessage = String(parsed.commitMessage ?? '').trim();
  if (!summary.length || !commitMessage) throw new Error('Local LLM response is missing summary or commitMessage.');
  return { summary, commitMessage };
}

function truncatePatch(value) {
  const patch = String(value ?? '');
  if (patch.length <= MAX_PROMPT_PATCH_CHARS) return patch;
  return `${patch.slice(0, MAX_PROMPT_PATCH_CHARS)}\n\n# Patch truncated by Zipflow before sending to the local LLM.`;
}
