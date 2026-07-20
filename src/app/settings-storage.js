import { clearBackupStorage, inspectBackupStorage } from '../apply/backup-storage.js';
import { clearManagedArchives, inspectManagedArchives } from '../archive/disposition.js';
import { formatByteSize } from '../utils/size.js';
import { markBackupsRemoved } from '../runs/backup-status.js';

export async function refreshSettingsStorage(controller, { quiet = false } = {}) {
  const panel = controller.state.settingsPanel;
  if (!panel || panel.loadingStorage) return false;
  panel.loadingStorage = true;
  if (!quiet) controller.state.status = 'Scanning Zipflow storage';
  controller.invalidate();
  try {
    const [archives, backups] = await Promise.all([inspectManagedArchives(), inspectBackupStorage()]);
    panel.storageStats = { archives, backups, refreshedAt: new Date().toISOString() };
    if (!quiet) controller.toast('Storage statistics refreshed', 'success');
    return true;
  } catch (error) {
    panel.storageError = error.message;
    if (!quiet) controller.toast('Storage scan failed', 'error', 3, error.message);
    return false;
  } finally {
    panel.loadingStorage = false;
    controller.invalidate();
  }
}

export async function clearArchiveStorage(controller) {
  const result = await clearManagedArchives();
  await refreshSettingsStorage(controller, { quiet: true });
  const summary = `${result.removed.length} source archive${result.removed.length === 1 ? '' : 's'} · ${formatByteSize(result.totalBytes)}`;
  controller.toast(result.failed.length ? 'Source archives partially cleared' : 'Source archives cleared', result.failed.length ? 'warning' : 'success', 3, summary);
  return result;
}

export async function clearBackups(controller) {
  const activeRunId = activeRun(controller.state) ? controller.state.run.id : null;
  const result = await clearBackupStorage({ excludeRunId: activeRunId });
  await markBackupsRemoved(result.removed, { reason: 'manual-clear' });
  await refreshSettingsStorage(controller, { quiet: true });
  const kept = activeRunId ? ' · current run backup kept' : '';
  const summary = `${result.removed.length} backup${result.removed.length === 1 ? '' : 's'} · ${formatByteSize(result.totalBytes)}${kept}`;
  controller.toast(result.failed.length ? 'Backups partially cleared' : 'Backups cleared', result.failed.length ? 'warning' : 'success', 3, summary);
  return result;
}

function activeRun(state) {
  return Boolean(state.run && !['completed', 'failed', 'cancelled', 'rolled_back'].includes(state.run.status));
}
