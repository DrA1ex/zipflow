import path from 'node:path';

export function serverCommitMessage(privateState, runId) {
  return serverCommitMessageCandidates(privateState, runId)[0]?.message ?? '';
}

export function serverCommitMessageCandidates(privateState, runId) {
  const workflow = privateState?.workflow ?? {};
  const strategy = workflow.git?.messageStrategy ?? 'metadata';
  const values = {
    llm: {
      label: 'Local LLM',
      message: clean(privateState?.llm?.commitMessage),
      detail: 'Generated from the reviewed archive update.',
    },
    metadata: {
      label: 'Archive metadata',
      message: clean(privateState?.metadata?.commitMessage),
      detail: 'Read from Zipflow commit-message metadata in the archive.',
    },
    fixed: {
      label: 'Workflow template',
      message: strategy === 'fixed'
      ? renderTemplate(workflow.git?.fixedMessage, privateState, runId)
      : '',
      detail: 'Rendered from the configured workflow template.',
    },
    generated: {
      label: strategy === 'archive' ? 'Archive filename' : 'Generated',
      message: strategy === 'archive'
        ? `Apply ${privateState?.binding?.blob?.filename || 'archive update'}`
        : `zipflow: apply ${runId}`,
      detail: 'Deterministic Zipflow fallback.',
    },
  };
  if (strategy === 'llm' && !values.llm.message) return [];
  const preferred = strategy === 'metadata'
    ? 'metadata'
    : strategy === 'fixed'
      ? 'fixed'
      : strategy === 'archive' ? 'generated' : 'llm';
  const seen = new Set();
  return [preferred, 'llm', 'metadata', 'fixed', 'generated']
    .map((id) => ({ id, ...values[id] }))
    .filter(({ message }) => {
      if (!message || seen.has(message)) return false;
      seen.add(message);
      return true;
    });
}

function renderTemplate(template, privateState, runId) {
  const now = new Date();
  const projectName = path.basename(privateState?.binding?.projectPath ?? '') || 'Project';
  return clean(String(template ?? 'zipflow: apply {runId}')
    .replaceAll('{runId}', runId)
    .replaceAll('{archiveName}', privateState?.binding?.blob?.filename || 'archive update')
    .replaceAll('{projectName}', projectName)
    .replaceAll('{date}', now.toISOString().slice(0, 10))
    .replaceAll('{time}', now.toTimeString().slice(0, 8)));
}

function clean(value) {
  if (typeof value !== 'string') return '';
  const message = value.trim();
  if (!message) return '';
  if (/^[\[{]/.test(message)) {
    try {
      JSON.parse(message);
      return '';
    } catch {}
  }
  return message.slice(0, 4_096);
}
