import { showRunDetails } from '../app/run-rollback.js';
import { setScreen } from '../app/state.js';
import { formatCompletionForClipboard } from '../runs/text-report.js';
import { copyZipflowText } from '../ui/clipboard.js';
import { loadClientHistoryMetadata } from './client-history-metadata.js';
import { loadClientPlanDiff } from './client-review-flow.js';

const CHANGED_GROUPS = Object.freeze([
  ['created', 'Added'],
  ['updated', 'Changed'],
  ['deleted', 'Removed'],
]);

export async function listClientHistoryRuns(controller, { limit = 40 } = {}) {
  const history = await controller.client.getHistory(controller.project.projectId, { limit });
  const items = history.items ?? history.runs ?? [];
  return Promise.all(items.map(async (item) => {
    if (controller.historyRunCache?.has(item.runId)) {
      return controller.historyRunCache.get(item.runId);
    }
    const report = await controller.client.getReport(item.runId).catch(() => null);
    const run = historyRunRecord(item, report);
    await applyClientMetadata(controller, run);
    controller.historyRunCache ??= new Map();
    controller.historyRunCache.set(item.runId, run);
    return run;
  }));
}

export async function loadClientHistoryRun(controller, runId) {
  controller.runId = runId;
  if (controller.historyRunCache?.has(runId)) {
    const cached = controller.historyRunCache.get(runId);
    if (cached.serverSurface) return cached;
  }
  const [resource, report, surface] = await Promise.all([
    controller.client.getRun(runId),
    controller.client.getReport(runId),
    controller.client.getSurface(runId),
  ]);
  const run = historyRunRecord(resource, report, surface);
  await applyClientMetadata(controller, run);
  controller.historyRunCache ??= new Map();
  controller.historyRunCache.set(runId, run);
  return run;
}

async function applyClientMetadata(controller, run) {
  const cached = controller.clientArchiveDispositions?.get(run.id);
  const metadata = cached
    ? { archiveDisposition: cached }
    : await loadClientHistoryMetadata(run.id).catch(() => null);
  if (metadata?.archiveDisposition) {
    run.archiveDisposition = structuredClone(metadata.archiveDisposition);
  }
  return run;
}

export function historyRunRecord(resource = {}, report = null, surface = null) {
  const summary = resource.summary && typeof resource.summary === 'object'
    ? resource.summary
    : {};
  const kind = resource.kind === 'checks'
    ? 'manual-checks'
    : resource.kind === 'deploy'
      ? 'manual-deploy'
      : null;
  const rollbackAction = surface?.actions?.find(({ id }) => id === 'rollback');
  return {
    version: 9,
    id: resource.runId ?? report?.runId,
    kind,
    status: resource.status ?? report?.status ?? 'created',
    projectName: report?.project?.name ?? summary.projectName ?? '',
    workflowName: report?.workflow?.name ?? summary.workflowName ?? '',
    archivePath: report?.archive?.filename ?? summary.archiveName ?? null,
    archiveInfo: report?.archive
      ? {
          size: report.archive.size,
          fileCount: report.archive.fileCount,
        }
      : null,
    plan: report?.plan ?? (summary.counts ? { counts: summary.counts } : null),
    checks: report?.checks ?? summary.checks ?? null,
    commit: report?.commit ?? summary.commit ?? null,
    deploy: report?.deploy ?? summary.deploy ?? null,
    rollback: report?.rollback ?? null,
    decisions: report?.decisions ?? [],
    llm: report?.llm ?? null,
    autonomy: report?.autonomy ?? { mode: 'manual' },
    applied: report?.applied ?? (rollbackAction?.enabled
      ? { backupAvailable: true, paths: [] }
      : null),
    createdAt: resource.createdAt ?? report?.createdAt,
    updatedAt: resource.updatedAt ?? report?.updatedAt,
    completedAt: resource.completedAt ?? report?.completedAt,
    serverSurface: surface ? structuredClone(surface) : null,
  };
}

export async function activateClientHistoryDetail(controller, item) {
  const { state } = controller;
  if (state.screen === 'run-details') {
    if (item.id === 'view-run-files') return showHistoryFileGroups(controller);
    if (item.id === 'view-run-diff') return showCompleteHistoryDiff(controller);
    if (item.id === 'view-run-decisions') return showHistoryDecisions(controller);
    if (item.id === 'copy-run-summary') return copyHistorySummary(controller);
  }
  if (state.screen === 'run-file-groups') {
    if (item.id.startsWith('run-group:')) {
      return showHistoryFileList(controller, item.id.slice('run-group:'.length));
    }
    if (item.id === 'run-files-back') return showHistoryRunDetails(controller);
  }
  if (state.screen === 'run-file-list') {
    if (item.diffPath) return openHistoryDiff(controller, item.diffPath);
    if (item.id === 'run-groups-back') return showHistoryFileGroups(controller);
  }
  if (state.screen === 'run-decisions') {
    if (item.id.startsWith('run-decision:')) {
      return showHistoryDecision(controller, Number(item.id.slice('run-decision:'.length)));
    }
    if (item.id === 'run-decisions-back') return showHistoryRunDetails(controller);
  }
  return false;
}

export function backClientHistoryDetail(controller) {
  if (controller.state.screen === 'run-file-list') return showHistoryFileGroups(controller);
  if (['run-file-groups', 'run-decisions'].includes(controller.state.screen)) {
    return showHistoryRunDetails(controller);
  }
  return false;
}

async function showHistoryFileGroups(controller) {
  const groups = await loadHistoryGroups(controller);
  const items = CHANGED_GROUPS.flatMap(([id, label]) => (
    groups[id]?.length
      ? [{
          id: `run-group:${id}`,
          label: `${label} · ${groups[id].length} ›`,
          description: 'Browse stored semantic paths and diffs.',
        }]
      : []
  ));
  items.push({ id: 'run-files-back', label: 'Back to run details' });
  setScreen(controller.state, 'run-file-groups', {
    status: 'Changed files',
    intro: [`${CHANGED_GROUPS.reduce((total, [id]) => total + groups[id].length, 0)} changed paths`],
    items,
  });
  controller.invalidate();
}

async function showHistoryFileList(controller, group) {
  const groups = await loadHistoryGroups(controller);
  const files = groups[group] ?? [];
  controller.state.historyPlanGroup = group;
  setScreen(controller.state, 'run-file-list', {
    status: `${group} files`,
    intro: [`${files.length} stored path${files.length === 1 ? '' : 's'}`],
    items: [
      ...files.map((file) => ({
        id: `run-file:${encodeURIComponent(file.path)}`,
        label: `${file.path} ›`,
        description: 'Open the server-projected stored diff.',
        diffPath: file.path,
      })),
      { id: 'run-groups-back', label: 'Back to changed-file groups' },
    ],
  });
  controller.invalidate();
}

async function showCompleteHistoryDiff(controller) {
  const groups = await loadHistoryGroups(controller);
  const files = CHANGED_GROUPS.flatMap(([id]) => groups[id]);
  if (!files.length) {
    controller.toast('No stored file diff is available', 'warning');
    return;
  }
  return openHistoryDiff(controller, files[0].path, files);
}

async function openHistoryDiff(controller, filePath, allFiles = null) {
  const groups = await loadHistoryGroups(controller);
  const files = allFiles ?? groups[controller.state.historyPlanGroup] ?? [];
  const item = files.find(({ path }) => path === filePath) ?? { path: filePath };
  const diff = await loadClientPlanDiff(controller, item);
  const fileIndex = Math.max(0, files.findIndex(({ path }) => path === filePath));
  controller.state.diffView = {
    diff,
    source: 'plan',
    files,
    fileIndex,
    mode: controller.state.settings?.lastDiffMode ?? 'unified',
    scroll: 0,
    hunkIndex: 0,
    hunkCount: 1,
    hunkOffsets: [0],
    returnScreen: controller.state.screen,
    returnItems: controller.state.menuItems,
    returnSourceItems: controller.state.menuSourceItems,
    returnIndex: controller.state.selectedIndex,
    returnStatus: controller.state.status,
    returnIntro: controller.state.panelIntro,
  };
  setScreen(controller.state, 'diff-view', {
    status: `Diff · ${filePath}`,
    intro: [],
  });
  controller.invalidate();
}

async function loadHistoryGroups(controller) {
  if (controller.state.historyPlan?.runId === controller.runId) {
    return controller.state.historyPlan.groups;
  }
  const groups = {};
  for (const [group] of CHANGED_GROUPS) {
    groups[group] = await loadPlanGroup(controller, group);
  }
  controller.state.historyPlan = { runId: controller.runId, groups };
  return groups;
}

async function loadPlanGroup(controller, group) {
  const items = [];
  let cursor = null;
  do {
    const page = await controller.client.getPlan(controller.runId, {
      group,
      cursor: cursor ?? undefined,
      limit: 100,
    });
    items.push(...(page.items ?? []).map((item) => ({ ...item, kind: group })));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return items;
}

async function copyHistorySummary(controller) {
  const copied = await copyZipflowText(
    formatCompletionForClipboard(controller.state.run),
    { output: controller.runtime?.output },
  );
  return copied
    ? controller.toast('Run summary copied', 'success')
    : controller.setStatus('Clipboard transfer unavailable');
}

function showHistoryDecisions(controller) {
  const decisions = controller.state.run.decisions?.filter?.(({ gate }) => gate) ?? [];
  setScreen(controller.state, 'run-decisions', {
    status: 'Autopilot decisions',
    intro: [`${decisions.length} bounded decision${decisions.length === 1 ? '' : 's'} recorded`],
    items: [
      ...decisions.map((decision, index) => ({
        id: `run-decision:${index}`,
        label: `${decision.gate} · ${decision.action} · ${decision.executionStatus ?? 'unknown'}`,
        description: decision.summary ?? '',
      })),
      { id: 'run-decisions-back', label: 'Back to run details' },
    ],
  });
  controller.invalidate();
}

function showHistoryDecision(controller, index) {
  const decision = (controller.state.run.decisions?.filter?.(({ gate }) => gate) ?? [])[index];
  if (!decision) return showHistoryDecisions(controller);
  controller.message('Autopilot decision details', [
    `Gate: ${decision.gate}`,
    `Action: ${decision.action}`,
    `Execution: ${decision.executionStatus ?? 'unknown'}`,
    `Source: ${decision.source ?? 'llm'}`,
    `Summary: ${decision.summary ?? 'No summary recorded.'}`,
    ...(decision.evidence?.length ? ['Evidence:', ...decision.evidence.map((value) => `• ${value}`)] : []),
    ...(decision.risks?.length ? ['Risks:', ...decision.risks.map((value) => `• ${value}`)] : []),
  ]);
  return showHistoryDecisions(controller);
}

function showHistoryRunDetails(controller) {
  return showRunDetails(controller, controller.state.run, {
    origin: controller.state.runDetailsOrigin,
    announce: false,
  });
}
