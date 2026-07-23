import { exists } from '../utils/fs.js';
import { displayPath, expandHome } from '../utils/paths.js';
import { listProjectRuns, loadRunRecord } from '../runs/store.js';
import { compactPlanLine, formatDuration, runStatusLabel } from '../ui/format.js';
import { buildRunAnalytics } from '../history/analytics.js';
import {
  RUN_STATUS_FILTERS,
  RUN_TYPE_FILTERS,
  matchesRunStatus,
  matchesRunType,
  runStatusFilterDescription,
  runStatusFilterLabel,
  runTypeFilterDescription,
  runTypeLabel,
  runTypeTag,
} from '../history/presentation.js';
import { showRunDetails } from './run-rollback.js';

export function handlesHistoryScreen(screen) {
  return ['run-history', 'run-history-type-filter', 'run-history-status-filter', 'run-analytics'].includes(screen);
}

export async function showRunHistory(controller, selectedIndex = null) {
  normalizeLegacyFilter(controller.state);
  const runs = await listProjectRuns(controller.state.project.root, { limit: 40 });
  controller.state.historyRuns = runs;
  const filtered = runs.filter((run) => matchesRunType(run, controller.state.historyTypeFilter)
    && matchesRunStatus(run, controller.state.historyStatusFilter));
  const items = [{
    id: 'history-type-filter',
    label: `Type: ${runTypeLabel(controller.state.historyTypeFilter)}`,
    description: `${filtered.length} of ${runs.length} runs shown after both filters`,
  }, {
    id: 'history-status-filter',
    label: `Result: ${runStatusFilterLabel(controller.state.historyStatusFilter)}`,
    description: 'Filter success, failure, or rollback independently from the run type',
  }, {
    id: 'history-analytics',
    label: 'Performance analytics',
    description: 'Check and local LLM duration history, success rate, medians, and recent trend',
  }, ...filtered.map((run) => ({
    id: `history:${run.id}`,
    label: `[${runTypeTag(run)}] ${runStatusLabel(run.status)} · ${formatWhen(run.createdAt)}`,
    description: historyDescription(run),
    searchText: `${runTypeTag(run)} ${run.id} ${run.archivePath ?? ''} ${run.commit?.message ?? ''} ${run.commit?.revision ?? ''}`,
  }))];
  if (filtered.length === 0) items.push({ id: 'history-empty', label: 'No runs match these filters', disabled: true });
  items.push({ id: 'history-back', label: 'Back to project' });
  controller.showMenu('run-history', items, 'Project run history', selectedIndex, [
    `${filtered.length} of ${runs.length} recent run${runs.length === 1 ? '' : 's'} · / searches archive, run ID, commit, or revision`,
  ]);
}

function showTypeFilter(controller) {
  controller.showMenu('run-history-type-filter', RUN_TYPE_FILTERS.map((value) => ({
    id: `history-type:${value}`,
    label: `${controller.state.historyTypeFilter === value ? '●' : '○'} ${runTypeLabel(value)}`,
    description: runTypeFilterDescription(value),
  })), 'Filter run type', Math.max(0, RUN_TYPE_FILTERS.indexOf(controller.state.historyTypeFilter)));
}

function showStatusFilter(controller) {
  controller.showMenu('run-history-status-filter', RUN_STATUS_FILTERS.map((value) => ({
    id: `history-status:${value}`,
    label: `${controller.state.historyStatusFilter === value ? '●' : '○'} ${runStatusFilterLabel(value)}`,
    description: runStatusFilterDescription(value),
  })), 'Filter run result', Math.max(0, RUN_STATUS_FILTERS.indexOf(controller.state.historyStatusFilter)));
}

export async function activateHistory(controller, itemId) {
  if (itemId === 'history-back') return controller.showHome();
  if (itemId === 'history-type-filter') { controller.state.historyReturnIndex = controller.state.selectedIndex; return showTypeFilter(controller); }
  if (itemId === 'history-status-filter') { controller.state.historyReturnIndex = controller.state.selectedIndex; return showStatusFilter(controller); }
  if (itemId.startsWith('history-type:')) {
    controller.state.historyTypeFilter = itemId.slice(13);
    return showRunHistory(controller, controller.state.historyReturnIndex ?? 0);
  }
  if (itemId.startsWith('history-status:')) {
    controller.state.historyStatusFilter = itemId.slice(15);
    return showRunHistory(controller, controller.state.historyReturnIndex ?? 1);
  }
  if (itemId === 'history-analytics') { controller.state.historyReturnIndex = controller.state.selectedIndex; return showRunAnalytics(controller); }
  if (itemId === 'analytics-back') return showRunHistory(controller, controller.state.historyReturnIndex ?? 2);
  if (itemId.startsWith('analytics:')) return;
  if (!itemId.startsWith('history:')) return;
  const run = await loadRunRecord(itemId.slice(8));
  if (!run) {
    controller.message('Run report is missing', [itemId.slice(8)], 'warning');
    return showRunHistory(controller, controller.state.selectedIndex);
  }
  controller.state.historyReturnIndex = controller.state.selectedIndex;
  controller.state.run = run;
  controller.state.runDetailsOrigin = 'history';
  return showRunDetails(controller, run, { origin: 'history' });
}

export function backHistory(controller) {
  if (['run-analytics', 'run-history-type-filter', 'run-history-status-filter'].includes(controller.state.screen)) {
    return showRunHistory(controller, controller.state.historyReturnIndex ?? null);
  }
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
    helpTitle: 'Performance analytics',
    helpLines: metricHelpLines(analytics.checks.total, { sampleLabel: 'Recorded runs' }),
  });
  for (const check of analytics.checks.byName) items.push({
    id: `analytics:check:${check.name}`,
    label: check.name,
    description: `${metricDescription(check)} · ${check.count} samples`,
    helpTitle: 'Performance analytics',
    helpLines: metricHelpLines(check, { sampleLabel: 'Recorded samples' }),
  });
  if (analytics.llm.total.count) items.push({
    id: 'analytics:llm-total',
    label: `Local LLM overall · ${analytics.llm.total.count} runs`,
    description: `${metricDescription(analytics.llm.total)} · ${analytics.llm.truncated} reduced inputs · ${analytics.llm.averageAttempts.toFixed(1)} avg attempts`,
    helpTitle: 'Performance analytics',
    helpLines: metricHelpLines(analytics.llm.total, {
      sampleLabel: 'Recorded requests',
      extra: [
        '',
        'Delivery',
        `Reduced inputs: ${analytics.llm.truncated}`,
        `Average attempts: ${analytics.llm.averageAttempts.toFixed(1)}`,
      ],
    }),
  });
  for (const model of analytics.llm.byModel) items.push({
    id: `analytics:llm:${model.name}`,
    label: model.name,
    description: `${metricDescription(model)} · ${model.count} samples`,
    helpTitle: 'Performance analytics',
    helpLines: metricHelpLines(model, {
      sampleLabel: 'Recorded requests',
      extra: [
        '',
        'Delivery',
        `Reduced inputs: ${model.truncated}`,
        `Average attempts: ${model.averageAttempts.toFixed(1)}`,
      ],
    }),
  });
  if (!items.length) items.push({ id: 'analytics-empty', label: 'No timing data recorded yet', description: 'Complete checks or a local LLM request to build history.' });
  items.push({ id: 'analytics-back', label: 'Back to run history' });
  controller.showMenu('run-analytics', items, 'Performance analytics', null, [
    `${runs.length} recent runs inspected`,
    'Medians resist occasional slow starts; trend compares the three newest samples with the previous three.',
  ]);
}


function metricHelpLines(metric, { sampleLabel = 'Samples', extra = [] } = {}) {
  return [
    'Overview',
    `${sampleLabel}: ${metric.count}`,
    '',
    'Timing',
    `Median: ${formatDuration(metric.medianMs)}`,
    `Average: ${formatDuration(metric.averageMs)}`,
    `Fastest: ${formatDuration(metric.minMs)}`,
    `Slowest: ${formatDuration(metric.maxMs)}`,
    '',
    'Reliability',
    `Success rate: ${Math.round(metric.successRate * 100)}%`,
    '',
    'Recent trend',
    metric.trend,
    ...extra,
  ];
}

function metricDescription(metric) {
  return `median ${formatDuration(metric.medianMs)} · average ${formatDuration(metric.averageMs)} · ${Math.round(metric.successRate * 100)}% success · ${metric.trend}`;
}

export async function repeatLastArchive(controller) {
  const runId = controller.state.workflow?.lastRunId;
  if (!runId) return controller.message('No previous archive', ['This workflow has no prior run to repeat.'], 'warning');
  const run = await loadRunRecord(runId);
  if (!run) return controller.message('Previous run is missing', [runId], 'warning');
  const candidates = [...new Set([
    run.archiveDisposition?.action === 'deleted' ? null : run.archiveDisposition?.path,
    run.archiveDisposition?.action === 'deleted' ? null : run.archiveDisposition?.originalPath,
    run.archivePath,
  ].filter(Boolean).map((candidate) => expandHome(String(candidate))))];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      controller.message('Repeating previous archive', [
        displayPath(candidate),
        `Previous run: ${run.id}`,
        'The current Local LLM settings are used again. Esc skips only the LLM step and continues the update.',
      ], 'choice');
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

function historyDescription(run) {
  if (run.kind === 'manual-checks') {
    const checks = run.checks;
    return `${checks ? `${checks.passed} passed · ${checks.failed} failed` : 'No result recorded'} · no archive diff`;
  }
  if (run.kind === 'manual-deploy') return `${run.deploy?.ok ? 'Deployment passed' : run.deploy ? 'Deployment failed' : 'No result recorded'} · no archive diff`;
  const commit = run.commit?.message ? ` · ${firstLine(run.commit.message)}` : '';
  return `${archiveName(run)} · ${run.plan?.counts ? compactPlanLine({ counts: run.plan.counts }) : 'No plan recorded'}${commit}`;
}

function archiveName(run) {
  const value = run.archiveDisposition?.path || run.archivePath;
  return String(value || 'archive.zip').split(/[\\/]/).at(-1);
}

function normalizeLegacyFilter(state) {
  if (!state.historyStatusFilter || state.historyStatusFilter === 'all') {
    if (['successful', 'failed', 'rolled-back'].includes(state.historyFilter)) state.historyStatusFilter = state.historyFilter;
  }
  if (!state.historyTypeFilter || state.historyTypeFilter === 'all') {
    if (state.historyFilter === 'manual-checks') state.historyTypeFilter = 'test';
    if (state.historyFilter === 'deployment') state.historyTypeFilter = 'deploy';
  }
  state.historyFilter = 'all';
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/, 1)[0];
}
