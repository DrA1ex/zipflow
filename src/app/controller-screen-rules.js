export function isEditorScreen(screen) {
  return [
    'project-path-input', 'archive-input', 'custom-check-command', 'custom-check-name',
    'commit-message', 'commit-template', 'deploy-command', 'export-path', 'initial-commit-message',
  ].includes(screen);
}

export function shouldRecordChoice(screen, itemId) {
  if (['exit', 'back-home', 'history-back', 'back-to-plan', 'back-plan-categories', 'back-conflict-summary'].includes(itemId)) return false;
  return [
    'archive-safety', 'plan-review', 'conflict-summary', 'conflict-file', 'conflict-checkpoint', 'check-failed',
    'commit', 'deploy-prompt', 'deploy-failed', 'rollback-confirm', 'archive-duplicate',
  ].includes(screen);
}

export function isSearchableScreen(screen) {
  return String(screen ?? '').startsWith('setup-')
    || ['plan-files', 'export-select', 'export-files', 'run-history', 'run-file-list'].includes(screen);
}


export function isPagedMenuScreen(screen) {
  return String(screen ?? '').startsWith('setup-') || [
    'plan-files', 'export-select', 'export-files', 'run-history', 'run-details', 'run-file-groups', 'run-file-list', 'run-analytics',
    'run-history-type-filter', 'run-history-status-filter',
  ].includes(screen);
}
