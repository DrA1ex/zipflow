import { saveRunRecord, runReportPath } from '../runs/store.js';
import { saveWorkflow } from '../workflow/store.js';
import { displayPath } from '../utils/paths.js';
import { compactPlanLine } from '../ui/format.js';
import { finalizeSourceArchive } from './archive-policy.js';
import { releaseRunResources } from './run-lifecycle.js';
import { activeRunSettings, clearRunSettings } from './runtime-settings.js';
import { pruneBackupStorage } from '../apply/backup-storage.js';
import { markBackupsRemoved } from '../runs/backup-status.js';
import { recentArchiveHint } from '../settings/recent.js';

export async function completeRun(controller, status) {
  const { state } = controller;
  state.run.status = status;
  state.run = await saveRunRecord(state.run);
  state.workflow.lastRunId = state.run.id;
  state.workflow = await saveWorkflow(state.workflow);
  await finalizeSourceArchive(controller);
  const backupCleanup = await pruneBackupStorage(activeRunSettings(state), { activeRunId: state.run.id }).catch(() => null);
  if (backupCleanup?.removed?.length) {
    await markBackupsRemoved(backupCleanup.removed, { reason: 'retention' }).catch(() => null);
    controller.toast(`${backupCleanup.removed.length} old backup${backupCleanup.removed.length === 1 ? '' : 's'} removed`, 'info');
  }
  await releaseRunResources(controller);
  controller.message('Final summary', finalSummaryLines(state), 'summary', {
    collapsedSummary: `Run complete · ${compactPlanLine(state.plan)} · ${checkSummaryLine(state.run.checks)}`,
  });
  clearRunSettings(state);
  showCompleted(controller);
}

export function finalSummaryLines(state) {
  const lines = [];
  if (state.run.llm?.summary?.length) lines.push(...state.run.llm.summary);
  const autonomy = state.run.autonomy?.mode && state.run.autonomy.mode !== 'manual'
    ? ` · Autopilot ${state.run.autonomy.mode}${state.run.autonomy.paused ? ' paused' : ''}`
    : '';
  lines.push(
    `${compactPlanLine(state.plan)} · ${checkSummaryLine(state.run.checks)} · Deployment ${deploymentResultLine(state)} · Source archive ${archiveDispositionLine(state.run.archiveDisposition)}${autonomy}`,
    `Commit ${state.run.commit ? `${state.run.commit.revision} ${firstLine(state.run.commit.message)}` : 'not created'} · Report ${displayPath(runReportPath(state.run.id))}`,
  );
  return lines;
}

export function showCompleted(controller) {
  const { state } = controller;
  const items = [
    { id: 'home', label: 'Finish and wait for next archive', description: 'Keep Zipflow ready for the next ZIP; Esc returns to the project menu' },
    { id: 'copy-summary', label: 'Copy run summary', description: 'Copy a compact summary with changes, checks, commit, and deployment' },
    { id: 'view-report', label: 'View run details', description: 'Open the stored decisions, checks, commit, deployment, and report path' },
  ];
  if (state.workflow.deploy?.policy === 'on-demand' && !state.run.deploy?.ok) {
    items.push({ id: 'run-deploy', label: 'Run deployment', description: state.workflow.deploy.commandText });
  }
  if (!state.run.rollback || state.run.rollback.status !== 'completed') {
    items.push({ id: 'rollback', label: 'Roll back this update', description: 'Restore the exact local state from before this run' });
  }
  items.push({ id: 'project-menu', label: 'Return to project menu' });
  items.push({ id: 'exit', label: 'Exit' });
  const tag = state.run.autonomy?.mode && state.run.autonomy.mode !== 'manual'
    ? ` · ${state.run.autonomy.mode === 'full' ? 'FULL AUTOPILOT' : 'GUARDED AUTOPILOT'}`
    : '';
  controller.showMenu('completed', items, `Run completed${tag}`, 0);
}

export function beginAnotherArchive(controller) {
  controller.showEditor('archive-input', {
    label: 'ZIP archive path',
    placeholder: '~/Downloads/project-update.zip',
    purpose: 'archive-path',
    instructions: [
      'Drop a ZIP file into the terminal or enter its path. Tab completes ZIP paths.',
      ...(recentArchiveHint(controller.state.settings) ? [recentArchiveHint(controller.state.settings)] : []),
    ],
  }, '');
  controller.setStatus('Waiting for archive');
}

export function checkSummaryLine(checks) {
  if (!checks) return 'Checks not run';
  const total = Number(checks.passed ?? 0) + Number(checks.failed ?? 0);
  return checks.failed
    ? `Checks ${checks.passed}/${total} passed · ${checks.failed} failed`
    : `Checks ${checks.passed}/${total} passed`;
}

function deploymentResultLine(state) {
  if (!state.run.deploy) return state.workflow.deploy?.policy === 'on-demand' ? 'available on demand' : 'not run';
  if (state.run.deploy.skipped) return 'skipped';
  return state.run.deploy.ok ? 'passed' : 'failed';
}

function archiveDispositionLine(value) {
  if (!value) return 'not processed';
  if (value.action === 'moved') return `moved to ${displayPath(value.path)}`;
  if (value.action === 'deleted') return 'deleted by global policy';
  if (value.action === 'kept') return 'kept in original location';
  return value.error ? `policy failed: ${value.error}` : value.action;
}

function firstLine(value) {
  return String(value).split('\n')[0];
}
