import { clearBackupStorage, inspectBackupStorage } from '../apply/backup-storage.js';
import { clearManagedArchives, inspectManagedArchives } from '../archive/disposition.js';
import { formatByteSize } from '../utils/size.js';
import { markBackupsRemoved } from '../runs/backup-status.js';

export async function refreshSettingsStorage(controller, { quiet = false } = {}) {
  const panel = controller.state.settingsPanel;
  if (!panel || panel.loadingStorage) return false;
  if (controller.state.activeOperation) {
    if (!quiet) controller.toast('Storage scan is unavailable while another operation is active', 'warning');
    return false;
  }
  const operation = controller.beginOperation({ kind: 'storage-scan', label: 'Scanning Zipflow storage' });
  panel.loadingStorage = true;
  if (!quiet) controller.state.status = 'Scanning Zipflow storage';
  controller.invalidate();
  try {
    const [archives, backups] = await Promise.all([
      inspectManagedArchives({ signal: operation.signal }),
      inspectBackupStorage({ signal: operation.signal }),
    ]);
    panel.storageStats = { archives, backups, refreshedAt: new Date().toISOString() };
    if (!quiet) controller.toast('Storage statistics refreshed', 'success');
    return true;
  } catch (error) {
    const cancelled = error?.code === 'cancelled';
    panel.storageError = cancelled ? null : error.message;
    if (!quiet) controller.toast(cancelled ? 'Storage scan cancelled' : 'Storage scan failed', cancelled ? 'info' : 'error', 3, cancelled ? '' : error.message);
    return false;
  } finally {
    panel.loadingStorage = false;
    operation.finish();
    controller.invalidate();
  }
}

export async function clearArchiveStorage(controller) {
  const operation = controller.beginOperation({ kind: 'storage-cleanup', label: 'Clearing source archives' });
  let result = null;
  let cancelled = false;
  try {
    result = await clearManagedArchives({ signal: operation.signal });
  } catch (error) {
    if (error?.code !== 'cancelled') throw error;
    cancelled = true;
  } finally {
    operation.finish();
  }
  await refreshSettingsStorage(controller, { quiet: true });
  cancelled ||= Boolean(result?.cancelled);
  if (cancelled && !result) {
    controller.toast('Source archive cleanup cancelled', 'info');
    return false;
  }
  const summary = `${result.removed.length} source archive${result.removed.length === 1 ? '' : 's'} · ${formatByteSize(result.totalBytes)}`;
  if (cancelled) {
    controller.toast('Source archive cleanup stopped', 'info', 3, `${summary} removed before cancellation`);
    return result;
  }
  controller.toast(result.failed.length ? 'Source archives partially cleared' : 'Source archives cleared', result.failed.length ? 'warning' : 'success', 3, summary);
  return result;
}

export async function clearBackups(controller) {
  const activeRunId = activeRun(controller.state) ? controller.state.run.id : null;
  const operation = controller.beginOperation({ kind: 'storage-cleanup', label: 'Clearing backups' });
  let result = null;
  let cancelled = false;
  try {
    result = await clearBackupStorage({ excludeRunId: activeRunId, signal: operation.signal });
  } catch (error) {
    if (error?.code !== 'cancelled') throw error;
    cancelled = true;
  } finally {
    operation.finish();
  }
  if (result) await markBackupsRemoved(result.removed, { reason: 'manual-clear' });
  await refreshSettingsStorage(controller, { quiet: true });
  cancelled ||= Boolean(result?.cancelled);
  if (cancelled && !result) {
    controller.toast('Backup cleanup cancelled', 'info');
    return false;
  }
  const kept = activeRunId ? ' · current run backup kept' : '';
  const summary = `${result.removed.length} backup${result.removed.length === 1 ? '' : 's'} · ${formatByteSize(result.totalBytes)}${kept}`;
  if (cancelled) {
    controller.toast('Backup cleanup stopped', 'info', 3, `${summary} removed before cancellation`);
    return result;
  }
  controller.toast(result.failed.length ? 'Backups partially cleared' : 'Backups cleared', result.failed.length ? 'warning' : 'success', 3, summary);
  return result;
}

function activeRun(state) {
  return Boolean(state.run && !['completed', 'failed', 'cancelled', 'rolled_back'].includes(state.run.status));
}
