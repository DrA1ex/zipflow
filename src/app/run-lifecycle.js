import path from 'node:path';
import { removeIfExists } from '../utils/fs.js';
import { displayPath } from '../utils/paths.js';
import { getZipflowHome } from '../workflow/store.js';
import { runReportPath, saveRunRecord } from '../runs/store.js';
import { clearRunSettings } from './runtime-settings.js';

export async function cancelRun(controller) {
  if (controller.state.run && !controller.state.run.applied) {
    controller.state.run.status = 'cancelled';
    controller.state.run = await saveRunRecord(controller.state.run);
  }
  await releaseRunResources(controller);
  clearRunSettings(controller.state);
  controller.message('Update cancelled', ['The project was not changed.']);
  controller.showHome();
}

export async function failRun(controller, error, { retry = null, continueWithoutLlm = null, kind = null } = {}) {
  const { state } = controller;
  state.busy = false;
  const runWasApplied = Boolean(state.run?.applied);
  if (state.run) {
    state.run.status = 'failed';
    state.run.error = { message: error.message, stack: error.stack, code: error.code ?? null };
    state.run = await saveRunRecord(state.run);
  }
  await releaseRunResources(controller);
  clearRunSettings(state);
  const resolvedKind = kind ?? classifyFailure(error, state);
  controller.recovery = { error, retry, continueWithoutLlm, kind: resolvedKind };
  controller.message('Run failed', [
    error.message,
    state.run ? `Report: ${displayPath(runReportPath(state.run.id))}` : '',
  ].filter(Boolean), 'error', { collapsedSummary: `Run failed · ${error.message}` });
  const items = [];
  if (typeof retry === 'function') items.push({ id: 'retry-step', label: 'Retry this step', description: 'Repeat the failed operation without rebuilding the whole workflow' });
  if (!runWasApplied) items.push({ id: 'choose-another-archive', label: 'Choose another archive', description: 'Return to archive selection with the saved workflow' });
  if (resolvedKind === 'llm') {
    items.push({ id: 'open-llm-settings', label: 'Open Local LLM settings', description: 'Check provider, model, token, and run the model compatibility test' });
    if (typeof continueWithoutLlm === 'function') items.push({ id: 'continue-without-llm', label: 'Continue without LLM', description: 'Keep deterministic planning, backups, conflict handling, and checks' });
  }
  items.push({ id: 'copy-diagnostics', label: 'Copy diagnostics', description: 'Copy the error, current screen, project, and run identifiers' });
  if (state.run) items.push({ id: 'view-report', label: 'View run report', description: `Open stored details for ${state.run.id}` });
  items.push({ id: 'back-home', label: 'Return to project' }, { id: 'exit', label: 'Exit' });
  controller.showMenu('error', items, 'Run failed');
}

function classifyFailure(error, state) {
  const value = `${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase();
  if (/llm|ollama|lm studio|model|token|context|completion/.test(value)) return 'llm';
  if (/archive|zip|extract|yauzl/.test(value) || !state.run?.applied) return 'archive';
  if (/check|test|command/.test(value)) return 'check';
  if (/deploy/.test(value)) return 'deploy';
  return 'unknown';
}

export async function releaseRunResources(controller) {
  controller.state.pendingArchiveInspection = null;
  await controller.activeLock?.release?.();
  controller.activeLock = null;
  if (controller.state.run?.id) await removeIfExists(path.join(getZipflowHome(), 'tmp', controller.state.run.id));
}
