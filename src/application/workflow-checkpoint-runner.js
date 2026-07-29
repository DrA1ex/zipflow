import { buildDirtyTreeChangeSet } from '../git/dirty-tree.js';
import { createCheckpointRef } from '../git/repository.js';
import { generateChangeDescription, isLocalLlmEnabled } from '../llm/generate.js';
import { isLlmDirtyTreeCommitMessageEnabled } from '../llm/tasks.js';

export function workflowCheckpointRequired(privateState) {
  if (privateState?.checkpointResolution) return false;
  const policy = privateState?.workflow?.git?.checkpoint ?? 'never';
  if (!['ask', 'auto'].includes(policy)) return false;
  if (!privateState?.plan?.gitStatus) return false;
  const decisions = new Map(
    (privateState.decisions ?? []).map(({ path, decision }) => [path, decision]),
  );
  return (privateState.conflicts ?? []).some(({ path }) => decisions.get(path) === 'archive');
}

export async function createWorkflowCheckpoint({
  runId,
  project,
  privateState,
  signal = null,
  onProgress = null,
  buildChangeSet = buildDirtyTreeChangeSet,
  createRef = createCheckpointRef,
  generateDescription = generateChangeDescription,
} = {}) {
  const settings = privateState?.settings ?? {};
  onProgress?.({ phase: 'checkpoint_changes', label: 'Inspecting current Git changes' });
  const changeSet = await buildChangeSet(project.root, { signal });
  let message = `zipflow checkpoint ${runId}`;
  let messageSource = 'generated';
  let llmError = null;
  if (
    changeSet.entries.length
    && isLlmDirtyTreeCommitMessageEnabled(settings)
    && isLocalLlmEnabled(settings)
  ) {
    onProgress?.({ phase: 'checkpoint_message', label: 'Generating checkpoint message' });
    try {
      const result = await generateDescription({
        settings,
        project,
        plan: changeSet.plan,
        patchContent: changeSet.patchContent,
      }, {
        signal,
        onEvent: (event) => onProgress?.({
          phase: event?.phase || event?.type || 'checkpoint_message',
          label: event?.label || '',
        }),
        tasks: { archiveReview: false, summary: false, commitMessage: true },
        changeContext: 'Current uncommitted tracked working-tree changes before the archive update',
      });
      const candidate = cleanCommitMessage(result?.commitMessage);
      if (candidate) {
        message = candidate;
        messageSource = 'llm';
      }
    } catch (error) {
      if (error?.code === 'cancelled') throw error;
      llmError = String(error?.message ?? error);
    }
  }
  onProgress?.({ phase: 'checkpoint_git', label: 'Creating Git checkpoint' });
  const checkpoint = await createRef(project.root, runId, { signal, message });
  if (!checkpoint.ok) {
    throw Object.assign(new Error(checkpoint.reason || 'Git checkpoint could not be created.'), {
      code: 'GIT_CHECKPOINT_FAILED',
      status: 409,
      expose: true,
      detail: checkpoint.reason || 'Git checkpoint could not be created.',
    });
  }
  return {
    revision: checkpoint.revision ?? null,
    ref: checkpoint.ref ?? null,
    paths: checkpoint.paths ?? [],
    backupOnlyPaths: checkpoint.untrackedPaths ?? [],
    preservesIndex: true,
    message,
    messageSource,
    llmError,
  };
}

function cleanCommitMessage(value) {
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
