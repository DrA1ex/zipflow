export function showWorkflowRestartConfirmation(controller) {
  controller.showMenu('setup-restart-confirm', [
    {
      id: 'restart-workflow-confirm',
      label: 'Start a new workflow setup',
      description: 'Discard only the current draft and rebuild recommendations from the workspace.',
    },
    {
      id: 'restart-workflow-cancel',
      label: 'Keep editing this workflow',
      description: 'Return without changing the draft or the saved workflow.',
    },
  ], 'Start workflow setup over', 1, [
    'The saved workflow remains active until the replacement workflow reaches Review and save.',
    'Leaving the new setup before saving keeps the current workflow unchanged.',
  ]);
}

export function activateWorkflowRestart(controller, itemId, { onConfirm, onCancel }) {
  if (itemId === 'restart-workflow-cancel') return onCancel();
  if (itemId === 'restart-workflow-confirm') return onConfirm();
}

export function cancelWorkflowSetup(controller) {
  const { state } = controller;
  if (state.setupProjectSnapshot) state.project = state.setupProjectSnapshot;
  state.setupProjectSnapshot = null;
  state.draft = null;
  state.setupEditing = false;
  state.setupSection = null;
  state.pendingProjectEntry = null;
  return controller.showHome();
}
