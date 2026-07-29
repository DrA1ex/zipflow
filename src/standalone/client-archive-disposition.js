import { applySourceArchivePolicy } from '../archive/disposition.js';
import { inspectArchiveFile } from '../security/archive-input.js';
import { exists } from '../utils/fs.js';
import { hashFile } from '../utils/hash.js';
import { displayPath } from '../utils/paths.js';
import { formatByteSize } from '../utils/size.js';
import { saveClientHistoryMetadata } from './client-history-metadata.js';

export async function finalizeClientSourceArchive(controller, runId, source) {
  const operation = controller.beginOperation({
    kind: 'source-archive-policy',
    label: 'Finalizing source archive',
  });
  try {
    if (await exists(source.path)) {
      const inspected = await inspectArchiveFile(source.path);
      const currentHash = await hashFile(inspected.path, { signal: operation.signal });
      if (/^[a-f0-9]{64}$/.test(source.hash) && currentHash !== source.hash) {
        throw Object.assign(
          new Error('The source ZIP changed after it was uploaded. Zipflow left the replacement file untouched.'),
          { code: 'source_archive_changed' },
        );
      }
    }
    const result = await applySourceArchivePolicy({
      archivePath: source.path,
      runId,
      settings: controller.state.settings,
      signal: operation.signal,
    });
    controller.state.run.archiveDisposition = result;
    rememberDisposition(controller, runId, result);
    await persistDisposition(controller, runId, result);
    emitDisposition(controller, result);
    return result;
  } catch (error) {
    const result = {
      action: 'failed',
      originalPath: source.path,
      error: String(error?.message ?? error),
    };
    controller.state.run.archiveDisposition = result;
    rememberDisposition(controller, runId, result);
    await persistDisposition(controller, runId, result);
    controller.message('Source archive policy could not be applied', [
      result.error,
      'The project update remains completed.',
    ], 'warning');
    return result;
  } finally {
    operation.finish();
  }
}

function rememberDisposition(controller, runId, result) {
  controller.clientArchiveDispositions ??= new Map();
  controller.clientArchiveDispositions.set(runId, structuredClone(result));
}

async function persistDisposition(controller, runId, result) {
  try {
    await saveClientHistoryMetadata(runId, { archiveDisposition: result });
  } catch (error) {
    controller.message('Source archive history could not be saved', [
      String(error?.message ?? error),
      'The source archive policy was still applied.',
    ], 'warning');
  }
}

function emitDisposition(controller, result) {
  if (result.action === 'moved') {
    controller.message('Source archive moved', [
      displayPath(result.path),
      ...(result.pruned.length
        ? [`Cleanup removed ${result.pruned.length} older archives · ${formatByteSize(
            result.pruned.reduce((sum, record) => sum + (record.size ?? 0), 0),
          )}`]
        : []),
    ], 'info');
  } else if (result.action === 'deleted') {
    controller.message('Source archive deleted', [
      'The saved global policy was applied after the server-owned update completed.',
    ], 'warning');
  } else if (result.action === 'missing') {
    controller.message('Source archive was already missing', [
      displayPath(result.originalPath),
    ], 'warning');
  }
}
