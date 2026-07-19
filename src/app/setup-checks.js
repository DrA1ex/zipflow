export function showChecksStep(controller, selectedIndex = null) {
  const checks = controller.state.draft.checks;
  const items = checks.map((check, index) => ({
    id: `check:${index}`,
    label: `${check.selected ? '[x]' : '[ ]'} ${check.name}`,
    description: `${check.description ?? check.type}${check.custom ? ' · custom command' : ''}`,
  }));
  items.push({ id: 'add-check', label: '+ Add custom command', description: 'Define an additional project validation command' });
  items.push({ id: 'checks-continue', label: 'Continue', description: `${checks.filter((item) => item.selected).length} checks selected` });
  controller.showMenu('setup-checks', items, 'Select checks', selectedIndex);
}

export function activateChecks(controller, itemId, onContinue) {
  if (itemId === 'add-check') return beginCustomCheck(controller);
  if (itemId === 'checks-continue') {
    controller.message('Checks selected', controller.state.draft.checks.filter((check) => check.selected).map((check) => check.name));
    return onContinue();
  }
  if (itemId.startsWith('check:')) {
    const index = Number(itemId.slice(6));
    toggleCheck(controller.state, index);
    showChecksStep(controller, index);
  }
}

export function submitCustomCheckEditor(controller) {
  const { state } = controller;
  const purpose = state.editorContext?.purpose;
  if (purpose === 'custom-command') {
    const commandText = state.editor.value.trim();
    if (!commandText) return controller.setStatus('Enter the exact command Zipflow should run.');
    state.editorContext.pendingCommand = commandText;
    controller.showEditor('custom-check-name', {
      ...state.editorContext,
      label: 'Name shown in Zipflow',
      placeholder: suggestedName(commandText),
      purpose: 'custom-name',
      instructions: [
        `Command: ${commandText}`,
        'Now enter a short name that will identify this check in the workflow and run results.',
      ],
    }, state.editorContext.pendingName ?? suggestedName(commandText));
    return true;
  }
  if (purpose === 'custom-name') {
    const name = state.editor.value.trim();
    if (!name) return controller.setStatus('Enter a short display name for this check.');
    const index = state.editorContext.editingIndex;
    const commandText = state.editorContext.pendingCommand;
    const check = {
      id: index === null || index === undefined ? `custom:${Date.now()}` : state.draft.checks[index].id,
      name,
      description: commandText,
      kind: 'custom',
      type: 'custom',
      commandText,
      cwd: '.',
      selected: true,
      required: true,
      timeoutMs: 600_000,
      custom: true,
    };
    if (index === null || index === undefined) state.draft.checks.push(check);
    else state.draft.checks[index] = check;
    controller.message(index === null || index === undefined ? 'Custom check added' : 'Custom check updated', [check.name, check.commandText], 'success');
    showChecksStep(controller, index ?? state.draft.checks.length - 1);
    return true;
  }
  return false;
}

export function handleChecksShortcut(controller, key) {
  const { state } = controller;
  if (state.screen !== 'setup-checks') return false;
  const selected = state.menuItems[state.selectedIndex];
  if (key.name === 'space' && selected?.id.startsWith('check:')) {
    toggleCheck(state, Number(selected.id.slice(6)));
    showChecksStep(controller, state.selectedIndex);
    return true;
  }
  if (key.printable && key.text.toLowerCase() === 'a') {
    beginCustomCheck(controller);
    return true;
  }
  if (key.printable && key.text.toLowerCase() === 'e' && selected?.id.startsWith('check:')) {
    const index = Number(selected.id.slice(6));
    if (state.draft.checks[index]?.custom) beginCustomCheck(controller, index);
    return true;
  }
  if ((key.name === 'delete' || key.name === 'backspace') && selected?.id.startsWith('check:')) {
    const index = Number(selected.id.slice(6));
    if (state.draft.checks[index]?.custom) {
      const [removed] = state.draft.checks.splice(index, 1);
      controller.message('Custom check removed', [removed.name]);
      showChecksStep(controller, Math.max(0, index - 1));
    }
    return true;
  }
  return false;
}

export function beginCustomCheck(controller, editingIndex = null) {
  const existing = editingIndex === null ? null : controller.state.draft.checks[editingIndex];
  controller.showEditor('custom-check-command', {
    label: 'Command to run',
    placeholder: 'npm run test:custom',
    purpose: 'custom-command',
    editingIndex,
    pendingName: existing?.name ?? '',
    instructions: [
      'Enter the exact shell command Zipflow should run as a project check.',
      'You will choose the short display name on the next step.',
    ],
  }, existing?.commandText ?? '');
}

function toggleCheck(state, index) {
  const check = state.draft.checks[index];
  if (check) check.selected = !check.selected;
}

function suggestedName(commandText) {
  const value = commandText.trim();
  if (!value) return 'Project validation';
  return value.length <= 36 ? value : `${value.slice(0, 33)}...`;
}
