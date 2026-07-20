import { exists } from '../utils/fs.js';
import { displayPath } from '../utils/paths.js';
import { listProjectRuns, loadRunRecord } from '../runs/store.js';
import { compactPlanLine, formatDuration, runStatusLabel } from '../ui/format.js';
import { buildRunAnalytics } from '../history/analytics.js';
import { showRunDetails } from './run-rollback.js';

export function handlesHistoryScreen(screen) {
  return ['run-history', 'run-analytics'].includes(screen);
}

export async function showRunHistory(controller, selectedIndex = null) {
  const runs = await listProjectRuns(controller.state.project.root, { limit: 40 });
  controller.state.historyRuns = runs;
  const items = [{
    id: 'history-analytics',
    label: 'Performance analytics',
    description: 'Check and local LLM duration history, success rate, medians, and recent trend',
  }, ...runs.map((run) => ({
    id: `history:${run.id}`,
    label: `${runStatusLabel(run.status)} · ${formatWhen(run.createdAt)}`,
    description: `${archiveName(run)} · ${run.plan?.counts ? compactPlanLine({ counts: run.plan.counts }) : 'No plan recorded'}`,
  }))];
  if (runs.length === 0) items.push({ id: 'history-empty', label: 'No runs recorded yet', disabled: true });
  items.push({ id: 'history-back', label: 'Back to project' });
  controller.showMenu('run-history', items, 'Project run history', selectedIndex, [
    `${runs.length} recent run${runs.length === 1 ? '' : 's'} for this project`,
    'Open a run to inspect its decisions, checks, commit, deployment, and rollback state.',
  ]);
}

export async function activateHistory(controller, itemId) {
  if (itemId === 'history-back') return controller.showHome();
  if (itemId === 'history-analytics') return showRunAnalytics(controller);
  if (itemId === 'analytics-back') return showRunHistory(controller);
  if (itemId.startsWith('analytics:')) return;
  if (!itemId.startsWith('history:')) return;
  const run = await loadRunRecord(itemId.slice(8));
  if (!run) {
    controller.message('Run report is missing', [itemId.slice(8)], 'warning');
    return showRunHistory(controller, controller.state.selectedIndex);
  }
  controller.state.run = run;
  controller.state.runDetailsOrigin = 'history';
  return showRunDetails(controller, run, { origin: 'history' });
}

export function backHistory(controller) {
  if (controller.state.screen === 'run-analytics') return showRunHistory(controller);
  if (controller.state.screen === 'run-history') return controller.showHome();
  return false;
}

export async function showRunAnalytics(controller) {
  const runs = await listProjectRuns(controller.state.project.root, { limit: 100 });
  const analytics = buildRunAnalytics(runs);
  const items = [];
  if (analytics.checks.total.count) items.push({
    id: 'analytics:checks-total',
    label: `Checks overall · ${analytics.checks.total.count} runs`,
    description: metricDescription(analytics.checks.total),
  });
  for (const check of analytics.checks.byName) items.push({
    id: `analytics:check:${check.name}`,
    label: check.name,
    description: `${metricDescription(check)} · ${check.count} samples`,
  });
  if (analytics.llm.total.count) items.push({
    id: 'analytics:llm-total',
    label: `Local LLM overall · ${analytics.llm.total.count} runs`,
    description: `${metricDescription(analytics.llm.total)} · ${analytics.llm.truncated} reduced inputs · ${analytics.llm.averageAttempts.toFixed(1)} avg attempts`,
  });
  for (const model of analytics.llm.byModel) items.push({
    id: `analytics:llm:${model.name}`,
    label: model.name,
    description: `${metricDescription(model)} · ${model.count} samples`,
  });
  if (!items.length) items.push({ id: 'analytics-empty', label: 'No timing data recorded yet', description: 'Complete checks or a local LLM request to build history.' });
  items.push({ id: 'analytics-back', label: 'Back to run history' });
  controller.showMenu('run-analytics', items, 'Performance analytics', null, [
    `${runs.length} recent runs inspected`,
    'Medians resist occasional slow starts; trend compares the three newest samples with the previous three.',
  ]);
}

function metricDescription(metric) {
  return `median ${formatDuration(metric.medianMs)} · average ${formatDuration(metric.averageMs)} · ${Math.round(metric.successRate * 100)}% success · ${metric.trend}`;
}

export async function repeatLastArchive(controller) {
  const runId = controller.state.workflow?.lastRunId;
  if (!runId) return controller.message('No previous archive', ['This workflow has no prior run to repeat.'], 'warning');
  const run = await loadRunRecord(runId);
  if (!run) return controller.message('Previous run is missing', [runId], 'warning');
  const candidates = [
    run.archiveDisposition?.action === 'moved' ? run.archiveDisposition.path : null,
    run.archivePath,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      controller.message('Repeating previous archive', [displayPath(candidate), `Previous run: ${run.id}`], 'choice');
      return controller.inspectArchivePath(candidate, { allowDuplicate: true });
    }
  }
  controller.message('Previous archive is unavailable', [
    'The source ZIP was moved or deleted and cannot be found at its recorded locations.',
    `Run: ${run.id}`,
  ], 'warning');
}

function formatWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return date.toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function archiveName(run) {
  const value = run.archiveDisposition?.action === 'moved' ? run.archiveDisposition.path : run.archivePath;
  return String(value || 'archive.zip').split(/[\\/]/).at(-1);
}
