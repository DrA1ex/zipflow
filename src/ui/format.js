import path from 'node:path';
import { displayPath } from '../utils/paths.js';

export function projectSummary(project, workflow = null) {
  const labels = project.labels.length ? project.labels.join(' · ') : 'Project type not detected';
  const lines = [
    `Root: ${displayPath(project.root)}`,
    `Detected: ${labels}`,
    `Git: ${project.git ? 'repository detected' : 'not initialized'} · Workflow: ${workflow ? 'configured' : 'not configured'}`,
  ];
  if (workflow) {
    lines.push(...workflowOverviewLines(workflow));
  }
  return lines;
}

export function planSummary(plan) {
  return [
    `${plan.counts.created} created`,
    `${plan.counts.updated} updated`,
    `${plan.counts.deleted} deleted`,
    `${plan.counts.preserved ?? 0} preserved`,
    `${plan.counts.unchanged} unchanged`,
    `${plan.counts.skipped} ignored`,
    `${plan.counts.conflicts} conflicts`,
  ];
}


export function planActivityLines(plan) {
  const lines = [compactPlanLine(plan), compactPlanMeta(plan)];
  if (plan.ignoredIncoming.length) lines.push(`${plan.ignoredIncoming.length} incoming paths ignored by .gitignore`);
  if (plan.preserved.length) lines.push(`${plan.preserved.length} local paths preserved by the selected snapshot scope`);
  if (plan.conflicts.length) lines.push(`${plan.conflicts.length} affected local paths require a conflict decision`);
  return lines;
}

export function planDetailLines(plan, limit = 80) {
  const lines = [];
  for (const [title, items] of [
    ['Created', plan.created],
    ['Updated', plan.updated],
    ['Deleted', plan.deleted],
    ['Preserved local files', plan.preserved ?? []],
    ['Conflicts', plan.conflicts],
    ['Ignored', plan.skipped],
  ]) {
    if (!items.length) continue;
    lines.push(`${title} (${items.length})`);
    for (const item of items.slice(0, limit)) lines.push(`  ${item.path}${item.reason ? ` — ${item.reason}` : ''}`);
    if (items.length > limit) lines.push(`  … ${items.length - limit} more`);
    lines.push('');
  }
  return lines.length ? lines : ['No changed files.'];
}

export function checkSummary(checks) {
  return checks.map((check) => `${check.selected ? '[x]' : '[ ]'} ${check.name} — ${check.description ?? check.type}`);
}

export function formatDuration(milliseconds = 0) {
  return `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 0 : 1)}s`;
}

export function formatArchiveName(target) {
  return path.basename(target || 'archive.zip');
}

function formatCommitPolicy(value) {
  if (value === 'auto') return 'Automatic';
  if (value === 'never') return 'Never';
  return 'Ask after success';
}

function formatDeployPolicy(value) {
  if (value === 'always') return 'Always after success';
  if (value === 'ask') return 'Ask after success';
  if (value === 'on-demand') return 'On demand';
  return 'Disabled';
}

export function workflowOverviewLines(workflow) {
  if (!workflow) return [];
  const selectedChecks = workflow.checks.filter((check) => check.selected);
  const checkNames = selectedChecks.slice(0, 4).map((check) => check.name);
  if (selectedChecks.length > 4) checkNames.push(`+${selectedChecks.length - 4} more`);
  return [
    `Archive: ${workflow.archive.mode === 'snapshot' ? snapshotLabel(workflow.deletion.scope) : 'Overlay · missing files are kept'}`,
    `Conflicts: ${workflow.policy.conflictPolicy === 'overwrite' ? 'use archive after backup' : 'ask only for affected files'} · Plan: ${workflow.policy.confirmPlan ? 'always review' : 'auto-apply when safe'}`,
    `Checks: ${checkNames.length ? checkNames.join(', ') : 'none'}`,
    `Git: checkpoint ${shortPolicy(workflow.git.checkpoint)} · result commit ${shortPolicy(workflow.git.resultCommit)} · Deploy ${formatDeployPolicy(workflow.deploy?.policy).toLowerCase()}`,
  ];
}

export function compactPlanLine(plan) {
  return `${plan.counts.created} added · ${plan.counts.updated} changed · ${plan.counts.deleted} removed`;
}

export function compactPlanMeta(plan) {
  return `${plan.counts.unchanged} unchanged · ${plan.counts.skipped} ignored · ${plan.counts.preserved ?? 0} preserved · ${plan.counts.conflicts} conflicts`;
}

export function runStatusLabel(status) {
  const labels = {
    completed: 'Completed', completed_with_errors: 'Completed with errors', checks_failed: 'Checks failed',
    failed: 'Failed', cancelled: 'Cancelled', rolled_back: 'Rolled back', applied: 'Applied', checks_passed: 'Checks passed',
  };
  return labels[status] ?? String(status || 'Unknown').replaceAll('_', ' ');
}

export function runStep(state) {
  if (!state.run && !['archive-input', 'archive-duplicate'].includes(state.screen)) return null;
  const stages = [
    { number: 1, label: 'Archive', screens: ['archive-input', 'archive-duplicate', 'archive-root-choice', 'applying'] },
    { number: 2, label: 'Review', screens: ['archive-safety', 'plan-review', 'plan-details', 'plan-files', 'conflict-summary', 'conflict-file', 'conflict-checkpoint', 'diff-view'] },
    { number: 3, label: 'Apply', screens: ['applying'] },
    { number: 4, label: 'Checks', screens: ['checks-running', 'check-failed', 'commit-message', 'commit', 'deploy-prompt', 'deploy-running', 'deploy-failed'] },
    { number: 5, label: 'Finish', screens: ['completed', 'run-details', 'rollback-confirm', 'rolling-back'] },
  ];
  if (state.screen === 'applying') {
    if (state.busyLabel === 'Inspecting archive') return { number: 1, label: 'Archive' };
    return { number: 3, label: 'Apply' };
  }
  return stages.find((stage) => stage.screens.includes(state.screen)) ?? { number: 1, label: 'Archive' };
}

function snapshotLabel(scope) {
  if (scope === 'all') return 'Full snapshot · remove all non-ignored missing files';
  if (scope === 'managed-history') return 'Full snapshot · remove only Zipflow-managed files';
  return 'Full snapshot · remove clean Git-tracked files';
}

function shortPolicy(value) {
  if (value === 'auto') return 'automatic';
  if (value === 'never' || value === 'disabled') return 'off';
  return 'ask';
}
