import path from 'node:path';
import { displayPath } from '../utils/paths.js';

export function projectSummary(project, workflow = null) {
  const lines = [displayPath(project.root), project.labels.length ? project.labels.join(' · ') : 'Project type not detected'];
  if (project.git) lines[1] += ' · Git';
  if (workflow) {
    lines.push(`Archive: ${workflow.archive.mode === 'snapshot' ? 'Full snapshot' : 'Overlay'}`);
    lines.push(`Checks: ${workflow.checks.filter((check) => check.selected).length}`);
    lines.push(`Policy: ${workflow.policy.label}`);
    lines.push(`Commit: ${formatCommitPolicy(workflow.git.resultCommit)}`);
    lines.push(`Deploy: ${formatDeployPolicy(workflow.deploy?.policy)}`);
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
  const lines = [
    `${plan.counts.created} created · ${plan.counts.updated} updated · ${plan.counts.deleted} deleted`,
    `${plan.counts.unchanged} unchanged · ${plan.counts.skipped} skipped · ${plan.counts.conflicts} conflicts`,
  ];
  for (const [title, items] of [
    ['Created', plan.created],
    ['Updated', plan.updated],
    ['Deleted', plan.deleted],
    ['Preserved locally', plan.preserved ?? []],
    ['Skipped', plan.skipped],
  ]) {
    if (!items.length) continue;
    lines.push('', `${title} (${items.length})`);
    for (const item of items) lines.push(`  ${item.path}${item.reason ? ` — ${item.reason}` : ''}`);
  }
  if (plan.unchanged.length) lines.push('', `Unchanged files are not rewritten: ${plan.unchanged.length}`);
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
