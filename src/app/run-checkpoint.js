import { buildDirtyTreeChangeSet } from '../git/dirty-tree.js';
import { createCheckpointRef } from '../git/repository.js';
import { generateChangeDescription, isLocalLlmEnabled } from '../llm/generate.js';
import { isLlmDirtyTreeCommitMessageEnabled } from '../llm/tasks.js';
import { beginLlmProgress } from './llm-progress.js';
import { activeRunSettings } from './runtime-settings.js';

export async function createCheckpointSnapshot(controller, { operation }) {
  const { state } = controller;
  const settings = activeRunSettings(state);
  const changeSet = await buildDirtyTreeChangeSet(state.project.root, { signal: operation.signal });
  let message = `zipflow checkpoint ${state.run.id}`;
  let messageSource = 'generated';

  if (changeSet.entries.length && isLlmDirtyTreeCommitMessageEnabled(settings)) {
    if (isLocalLlmEnabled(settings)) {
      const progress = beginLlmProgress(controller);
      controller.message('Generating dirty-tree checkpoint message', [
        `Tracked changed paths: ${changeSet.entries.length}`,
        `Change delivery: ${deliveryLabel(settings.llmChangeDelivery)}`,
        'Zipflow is analyzing the current uncommitted tracked changes without modifying the working tree or index.',
      ], 'process');
      try {
        operation.update?.({ phase: 'Generating dirty-tree checkpoint message' });
        const result = await generateChangeDescription({
          settings,
          project: state.project,
          plan: changeSet.plan,
          patchContent: changeSet.patchContent,
        }, {
          signal: operation.signal,
          onEvent: progress.onEvent,
          tasks: { archiveReview: false, summary: false, commitMessage: true },
          changeContext: 'Current uncommitted tracked working-tree changes before the archive update',
        });
        const candidate = cleanCommitMessage(result?.commitMessage);
        if (candidate) {
          message = candidate;
          messageSource = 'llm';
          controller.message('Dirty-tree checkpoint message generated', [candidate], 'success', {
            collapsedSummary: `Checkpoint message · ${firstLine(candidate)}`,
          });
        } else {
          controller.message('Dirty-tree checkpoint message fallback', [
            'The local model did not return a usable commit message.',
            `Zipflow will use: ${message}`,
          ], 'warning');
        }
      } catch (error) {
        if (error.code === 'cancelled') throw error;
        controller.message('Dirty-tree checkpoint message fallback', [
          error.message,
          `Zipflow will use: ${message}`,
        ], 'warning');
      } finally {
        progress.stop();
      }
    } else {
      controller.message('Dirty-tree checkpoint message fallback', [
        'The LLM task is enabled, but no local provider and model are currently available.',
        `Zipflow will use: ${message}`,
      ], 'warning');
    }
  }

  operation.update?.({ phase: 'Creating Git checkpoint' });
  const checkpoint = await createCheckpointRef(state.project.root, state.run.id, {
    signal: operation.signal,
    message,
  });
  return { ...checkpoint, message, messageSource, changeSet };
}

function cleanCommitMessage(value) {
  if (typeof value !== 'string') return '';
  const message = value.trim();
  if (!message) return '';
  if (/^[\[{]/.test(message)) {
    try {
      JSON.parse(message);
      return '';
    } catch {
      // A valid commit message may begin with a bracket.
    }
  }
  return message;
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/, 1)[0];
}

function deliveryLabel(value) {
  if (value === 'patch') return 'full patch';
  if (value === 'change-list') return 'changed paths only';
  if (value === 'representative') return 'representative sample';
  if (value === 'capped') return 'capped batches';
  if (value === 'chunked') return 'file-by-file chunks';
  return 'adaptive';
}
