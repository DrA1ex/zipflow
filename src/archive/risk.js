import { listProjectRuns } from '../runs/store.js';

const OLD_ARCHIVE_SKEW_MS = 5 * 60 * 1000;
const MIN_SHRINK_FILES = 10;
const DELETE_RATIO_WARNING = 0.25;
const ARCHIVE_RATIO_WARNING = 0.6;

export async function evaluateArchiveRisks({ projectPath, workflow, archiveInfo, extracted, plan }) {
  const warnings = [];
  const previous = await latestComparableRun(projectPath);
  if (previous?.archiveInfo?.modifiedAt && archiveInfo?.modifiedAt) {
    const currentTime = Date.parse(archiveInfo.modifiedAt);
    const previousTime = Date.parse(previous.archiveInfo.modifiedAt);
    if (Number.isFinite(currentTime) && Number.isFinite(previousTime)
      && currentTime + OLD_ARCHIVE_SKEW_MS < previousTime) {
      warnings.push({
        id: 'older-than-last',
        severity: 'warning',
        title: 'Archive appears older than the last applied archive',
        detail: `Current ZIP: ${formatDate(currentTime)} · previous ZIP: ${formatDate(previousTime)}`,
      });
    }
  }
  if (workflow.archive.mode !== 'snapshot') return { warnings, previousRunId: previous?.id ?? null };
  const localScope = plan.updated.length + plan.unchanged.length + plan.deleted.length;
  const deleteRatio = localScope ? plan.deleted.length / localScope : 0;
  if (plan.deleted.length >= MIN_SHRINK_FILES && deleteRatio >= DELETE_RATIO_WARNING) {
    warnings.push({
      id: 'large-deletion',
      severity: deleteRatio >= 0.5 ? 'danger' : 'warning',
      title: 'Snapshot would remove a large part of the project',
      detail: `${plan.deleted.length} of ${localScope} managed paths would be removed (${percent(deleteRatio)}).`,
    });
  }
  const previousCount = previous?.archiveInfo?.fileCount;
  if (Number.isFinite(previousCount) && previousCount >= MIN_SHRINK_FILES) {
    const currentCount = extracted.fileCount;
    const ratio = currentCount / previousCount;
    if (previousCount - currentCount >= MIN_SHRINK_FILES && ratio <= ARCHIVE_RATIO_WARNING) {
      warnings.push({
        id: 'smaller-than-last',
        severity: ratio <= 0.35 ? 'danger' : 'warning',
        title: 'Snapshot contains far fewer files than the previous archive',
        detail: `${currentCount} files now · ${previousCount} previously (${percent(ratio)} of the previous size).`,
      });
    }
  }
  return { warnings: deduplicate(warnings), previousRunId: previous?.id ?? null };
}

async function latestComparableRun(projectPath) {
  const runs = await listProjectRuns(projectPath, { limit: 100 });
  return runs.find((run) => run.archiveInfo?.fileCount && [
    'applied', 'checks_passed', 'checks_failed', 'completed', 'completed_with_errors',
  ].includes(run.status)) ?? null;
}

function deduplicate(warnings) {
  const seen = new Set();
  return warnings.filter((item) => !seen.has(item.id) && seen.add(item.id));
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function formatDate(value) {
  return new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
