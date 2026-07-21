import { compactPlanLine, formatArchiveName } from '../ui/format.js';

export function showDuplicateWarning(controller, archivePath, archiveHash, previous) {
  controller.state.pendingArchive = { archivePath, archiveHash, previous };
  controller.showMenu('archive-duplicate', [
    { id: 'duplicate-choose-another', label: 'Choose another archive', description: 'Recommended when this ZIP was selected accidentally' },
    { id: 'duplicate-apply-again', label: 'Apply this archive again', description: 'Rebuild the plan against the current project state' },
    { id: 'duplicate-view-run', label: 'Show previous result', description: `Run ${previous.id} · ${previous.status}` },
  ], 'Archive was used before', 0, [
    formatArchiveName(archivePath),
    `Previously used: ${new Date(previous.createdAt).toLocaleString('en-GB')}`,
    previous.plan?.counts ? compactPlanLine({ counts: previous.plan.counts }) : 'Previous plan unavailable',
  ]);
}

export async function activateDuplicate(controller, itemId, { beginArchiveInput, inspectArchivePath }) {
  const pending = controller.state.pendingArchive;
  if (!pending) return beginArchiveInput(controller);
  if (itemId === 'duplicate-choose-another') return beginArchiveInput(controller);
  if (itemId === 'duplicate-apply-again') {
    return inspectArchivePath(controller, pending.archivePath, {
      allowDuplicate: true,
      archiveHash: pending.archiveHash,
    });
  }
  if (itemId === 'duplicate-view-run') {
    const run = pending.previous;
    controller.message('Previous archive result', [
      `Run: ${run.id} · ${run.status}`,
      ...(run.plan?.counts ? [compactPlanLine({ counts: run.plan.counts })] : []),
      `Commit: ${run.commit ? `${run.commit.revision} ${firstLine(run.commit.message)}` : 'none'}`,
    ]);
    return showDuplicateWarning(controller, pending.archivePath, pending.archiveHash, run);
  }
  return false;
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/, 1)[0];
}
