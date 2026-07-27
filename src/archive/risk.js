import { listProjectRuns } from '../runs/store.js';

const OLD_ARCHIVE_SKEW_MS = 5 * 60 * 1000;
const MIN_SHRINK_FILES = 10;
const DELETE_RATIO_WARNING = 0.25;
const ARCHIVE_RATIO_WARNING = 0.6;
const MIN_PATCH_SUSPICION_DELETIONS = 3;
const PATCH_DELETE_RATIO = 0.2;
const PATCH_UNCHANGED_RATIO = 0.25;

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
  const patchSuspicion = evaluatePotentialPatchArchive(plan);
  if (patchSuspicion) warnings.push(patchSuspicion);
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

export function evaluatePotentialPatchArchive(plan) {
  const created = plan.created?.length ?? 0;
  const updated = plan.updated?.length ?? 0;
  const unchanged = plan.unchanged?.length ?? 0;
  const deleted = plan.deleted?.length ?? 0;
  if (deleted < MIN_PATCH_SUSPICION_DELETIONS) return null;
  const localScope = updated + unchanged + deleted;
  const incomingManaged = created + updated + unchanged;
  if (!localScope || !incomingManaged) return null;
  const deleteRatio = deleted / localScope;
  const unchangedRatio = unchanged / incomingManaged;
  const changedIncoming = created + updated;
  const changeFocused = changedIncoming >= 1 && unchangedRatio <= PATCH_UNCHANGED_RATIO;
  const stronglyShrunk = deleted >= MIN_SHRINK_FILES && deleted >= incomingManaged;
  const smallPatchDominated = deleted >= MIN_PATCH_SUSPICION_DELETIONS
    && deleteRatio >= 0.4
    && deleted >= Math.max(2, changedIncoming * 2)
    && unchanged <= 2;
  if (!(deleteRatio >= PATCH_DELETE_RATIO && changeFocused) && !stronglyShrunk && !smallPatchDominated) return null;

  const missingAreas = missingTopLevelAreas(plan);
  const evidence = [
    `${changedIncoming} incoming paths are added or changed, but only ${unchanged} match the current project unchanged`,
    `${deleted} of ${localScope} managed local paths would be removed (${percent(deleteRatio)})`,
    missingAreas.length ? `${missingAreas.length} top-level area${missingAreas.length === 1 ? '' : 's'} appear only among removals: ${missingAreas.slice(0, 4).join(', ')}${missingAreas.length > 4 ? ', …' : ''}` : null,
  ].filter(Boolean);
  return {
    id: 'possible-patch-archive',
    severity: deleteRatio >= 0.5 || unchanged === 0 ? 'danger' : 'warning',
    title: 'Archive may be a patch rather than a full snapshot',
    detail: `${evidence.join('. ')}. Recheck this run as an overlay archive before applying if those removals are not intentional.`,
    recommendation: 'overlay',
    metrics: { created, updated, unchanged, deleted, localScope, incomingManaged, deleteRatio, unchangedRatio, missingAreas },
  };
}

function missingTopLevelAreas(plan) {
  const incoming = new Set([...plan.created ?? [], ...plan.updated ?? [], ...plan.unchanged ?? []]
    .map((item) => topLevel(item.path))
    .filter(Boolean));
  return [...new Set((plan.deleted ?? []).map((item) => topLevel(item.path)).filter(Boolean))]
    .filter((area) => !incoming.has(area))
    .sort();
}

function topLevel(filePath) {
  return String(filePath ?? '').replaceAll('\\', '/').split('/').filter(Boolean)[0] ?? '';
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
