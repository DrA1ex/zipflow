import {
  commandLocationLabel, formatCommandSpec, validateCommandSpec,
} from '../project/command-spec.js';

export function showChecksStep(controller, selectedIndex = null) {
  const checks = controller.state.draft.checks;
  const items = checks.map((check, index) => ({
    id: `check:${index}`,
    label: `${check.selected ? '[x]' : '[ ]'} ${check.name}`,
    description: checkDescription(check),
  }));
  items.push({ id: 'add-check', label: '+ Add custom command', description: 'Use a command directly, or path/ :: command to run in a subdirectory.' });
  items.push({ id: 'checks-continue', label: 'Continue', description: `${checks.filter((item) => item.selected).length} checks selected` });
  const initialIndex = selectedIndex ?? (controller.state.setupEditing && controller.state.screen !== 'setup-checks' ? items.length - 1 : null);
  controller.showMenu('setup-checks', items, 'Select checks', initialIndex, [
    'Commands without a directory run from the workspace root.',
    'Use path/ :: command for a project or any other directory inside the workspace.',
  ]);
}

export function activateChecks(controller, itemId, onContinue) {
  if (itemId === 'add-check') return beginCustomCheck(controller);
  if (itemId === 'checks-continue') {
    controller.message('Checks selected', controller.state.draft.checks.filter((check) => check.selected).map((check) => `${commandLocationLabel(check.cwd)} · ${check.name}`));
    return onContinue();
  }
  if (itemId.startsWith('check:')) {
    const index = Number(itemId.slice(6));
    toggleCheck(controller.state, index);
    showChecksStep(controller, index);
  }
}

export async function submitCustomCheckEditor(controller) {
  const { state } = controller;
  const purpose = state.editorContext?.purpose;
  if (purpose === 'custom-command') {
    let parsed;
    try {
      parsed = await validateCommandSpec(state.project.root, state.editor.value);
    } catch (error) {
      controller.setStatus(error.message);
      return true;
    }
    state.editorContext.pendingCommand = parsed.commandText;
    state.editorContext.pendingCwd = parsed.cwd;
    controller.showEditor('custom-check-name', {
      ...state.editorContext,
      label: 'Name shown in Zipflow',
      placeholder: suggestedName(parsed.commandText),
      purpose: 'custom-name',
      instructions: [
        `Directory: ${commandLocationLabel(parsed.cwd)}`,
        `Command: ${parsed.commandText}`,
        'Now enter a short name that will identify this check in the workflow and run results.',
      ],
    }, state.editorContext.pendingName ?? suggestedName(parsed.commandText));
    return true;
  }
  if (purpose === 'custom-name') {
    const name = state.editor.value.trim();
    if (!name) return controller.setStatus('Enter a short display name for this check.');
    const index = state.editorContext.editingIndex;
    const commandText = state.editorContext.pendingCommand;
    const cwd = state.editorContext.pendingCwd ?? '.';
    const check = {
      id: index === null || index === undefined ? `custom:${Date.now()}` : state.draft.checks[index].id,
      name,
      description: commandText,
      kind: 'custom',
      type: 'custom',
      commandText,
      cwd,
      projectPath: cwd,
      selected: true,
      required: true,
      timeoutMs: 600_000,
      custom: true,
    };
    if (index === null || index === undefined) state.draft.checks.push(check);
    else state.draft.checks[index] = check;
    controller.message(index === null || index === undefined ? 'Custom check added' : 'Custom check updated', [
      `Directory: ${commandLocationLabel(check.cwd)}`,
      `Command: ${check.commandText}`,
    ], 'success');
    showChecksStep(controller, index ?? state.draft.checks.length - 1);
    return true;
  }
  return false;
}

export function handleChecksShortcut(controller, key) {
  const { state } = controller;
  if (state.screen !== 'setup-checks') return false;
  const selected = state.menuItems[state.selectedIndex];
  if (key.shift && (key.name === 'up' || key.name === 'down') && selected?.id.startsWith('check:')) {
    const index = Number(selected.id.slice(6));
    const direction = key.name === 'up' ? -1 : 1;
    const target = Math.max(0, Math.min(state.draft.checks.length - 1, index + direction));
    if (target !== index) {
      const [moved] = state.draft.checks.splice(index, 1);
      state.draft.checks.splice(target, 0, moved);
      showChecksStep(controller, target);
      controller.setStatus(direction < 0 ? 'Check moved up' : 'Check moved down');
    }
    return true;
  }
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
    placeholder: 'npm test  or  web/ :: npm test',
    purpose: 'custom-command',
    editingIndex,
    pendingName: existing?.name ?? '',
    instructions: [
      'Without a path, the command runs from the workspace root.',
      'Use path/ :: command to run from another directory. Tab completes the path before ::.',
      'You will choose the short display name on the next step.',
    ],
  }, existing ? formatCommandSpec(existing) : '');
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

function checkDescription(check) {
  const command = check.commandText ?? check.description ?? check.type;
  const custom = check.custom ? ' · custom command' : '';
  return `${commandLocationLabel(check.cwd)} · ${command}${custom}`;
}
