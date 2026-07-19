import path from 'node:path';
import { writeJsonAtomic } from '../utils/fs.js';
import { runDirectory } from '../runs/store.js';

export async function saveLlmDiagnostics(runId, value) {
  const target = path.join(runDirectory(runId), 'llm-diagnostics.json');
  await writeJsonAtomic(target, sanitize(value));
  return target;
}

function sanitize(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'string' && item.length > 120_000) return `${item.slice(0, 120_000)}\n[truncated]`;
    if (item instanceof Error) return {
      name: item.name,
      message: item.message,
      code: item.code ?? null,
      status: item.status ?? null,
      provider: item.provider ?? null,
      retryableWithSmallerPrompt: Boolean(item.retryableWithSmallerPrompt),
      responseBody: item.responseBody ?? null,
      diagnostics: item.diagnostics ?? null,
    };
    return item;
  }));
}
