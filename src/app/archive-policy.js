import { applySourceArchivePolicy } from '../archive/disposition.js';
import { saveRunRecord } from '../runs/store.js';
import { displayPath } from '../utils/paths.js';
import { formatByteSize } from '../utils/size.js';
import { activeRunSettings } from './runtime-settings.js';
import { exists } from '../utils/fs.js';
import { inspectArchiveFile } from '../security/archive-input.js';
import { hashFile } from '../utils/hash.js';

export async function finalizeSourceArchive(controller) {
  const { state } = controller;
  if (!state.run || state.run.archiveDisposition) return state.run?.archiveDisposition ?? null;
  const operation = controller.beginOperation?.({ kind: 'source-archive-policy', label: 'Finalizing source archive' })
    ?? { signal: undefined, finish() {} };
  try {
    if (await exists(state.run.archivePath)) {
      const inspected = await inspectArchiveFile(state.run.archivePath);
      const currentHash = await hashFile(inspected.path, { signal: operation.signal });
      if (state.run.archiveHash && currentHash !== state.run.archiveHash) {
        const error = new Error('The source ZIP changed after it was inspected. Zipflow left the replacement file untouched.');
        error.code = 'source_archive_changed';
        throw error;
      }
    }
    const result = await applySourceArchivePolicy({
      archivePath: state.run.archivePath,
      runId: state.run.id,
      settings: activeRunSettings(state),
      signal: operation.signal,
    });
    state.run.archiveDisposition = result;
    state.run = await saveRunRecord(state.run);
    if (result.action === 'moved') {
      controller.message('Source archive moved', [
        displayPath(result.path),
        ...(result.pruned.length ? [`Cleanup removed ${result.pruned.length} older archives · ${formatByteSize(totalSize(result.pruned))}`] : []),
      ], 'info');
    } else if (result.action === 'deleted') {
      controller.message('Source archive deleted', [state.run.status === 'no_changes'
        ? 'The saved global policy was applied after the archive was verified.'
        : 'The saved global policy was applied after the update was kept.'], 'warning');
    } else if (result.action === 'missing') {
      controller.message('Source archive was already missing', [displayPath(result.originalPath)], 'warning');
    }
    return result;
  } catch (error) {
    state.run.archiveDisposition = { action: 'failed', originalPath: state.run.archivePath, error: error.message };
    state.run = await saveRunRecord(state.run);
    controller.message('Source archive policy could not be applied', [error.message, 'The project update remains completed.'], 'warning');
    return state.run.archiveDisposition;
  } finally {
    operation.finish();
  }
}

function totalSize(records) {
  return records.reduce((sum, record) => sum + (record.size ?? 0), 0);
}
