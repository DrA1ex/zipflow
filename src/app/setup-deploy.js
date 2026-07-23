import {
  commandLocationLabel, formatCommandSpec, validateCommandSpec,
} from '../project/command-spec.js';

export function showDeployPolicyStep(controller) {
  const value = controller.state.draft.deploy.policy;
  controller.showMenu('setup-deploy', [
    choice('deploy-disabled', value === 'disabled', 'No deploy command', 'Finish after checks and the optional result commit.'),
    choice('deploy-ask', value === 'ask', 'Ask after successful checks', 'Offer deployment after a successful update.'),
    choice('deploy-always', value === 'always', 'Always deploy after successful checks', 'Run deployment automatically after successful checks and the optional commit.'),
    choice('deploy-on-demand', value === 'on-demand', 'Deploy on demand', 'Keep deployment available without running it automatically.'),
    { id: 'deploy-continue', label: 'Continue', description: deployPolicyDescription(value) },
  ], 'Deployment after successful checks', setupContinueIndex(controller, 'setup-deploy', 4));
}

export function activateDeployPolicy(controller, itemId, onComplete) {
  if (itemId.startsWith('deploy-') && itemId !== 'deploy-continue') {
    controller.state.draft.deploy.policy = itemId.slice(7);
    return showDeployPolicyStep(controller);
  }
  if (itemId === 'deploy-continue') {
    if (controller.state.draft.deploy.policy === 'disabled') return onComplete();
    return showDeployCommandStep(controller);
  }
}

export function showDeployCommandStep(controller, selectedIndex = null) {
  const { project, draft } = controller.state;
  const candidates = project.deployCandidates ?? [];
  const items = candidates.map((candidate, index) => ({
    id: `deploy-candidate:${index}`,
    label: `${sameCommand(draft.deploy, candidate) ? '●' : '○'} ${candidate.name}`,
    description: `${commandLocationLabel(candidate.cwd)} · ${candidate.commandText}`,
  }));
  items.push({
    id: 'deploy-custom',
    label: `${draft.deploy.commandText && !candidates.some((candidate) => sameCommand(draft.deploy, candidate)) ? '●' : '○'} Enter a custom command`,
    description: draft.deploy.commandText
      ? `${commandLocationLabel(draft.deploy.cwd)} · ${draft.deploy.commandText}`
      : 'Use a command directly, or path/ :: command to run in a subdirectory.',
  });
  items.push({
    id: 'deploy-command-continue', label: 'Continue',
    description: draft.deploy.commandText
      ? `${commandLocationLabel(draft.deploy.cwd)} · ${draft.deploy.commandText}`
      : 'Choose a detected command or enter your own.',
    disabled: !draft.deploy.commandText,
  });
  const initial = selectedIndex ?? (controller.state.setupEditing ? items.length - 1 : 0);
  controller.showMenu('setup-deploy-command', items, 'Choose deployment command', initial, candidates.length
    ? [`${candidates.length} suitable command${candidates.length === 1 ? '' : 's'} found across the selected projects.`]
    : ['No deploy-like command was detected. Enter the command Zipflow should run.']);
}

export function activateDeployCommand(controller, itemId, onComplete) {
  if (itemId.startsWith('deploy-candidate:')) {
    const candidate = controller.state.project.deployCandidates?.[Number(itemId.slice(17))];
    if (!candidate) return;
    Object.assign(controller.state.draft.deploy, {
      commandText: candidate.commandText,
      cwd: candidate.cwd ?? '.',
      name: candidate.name,
      source: candidate.source ?? 'detected',
    });
    return showDeployCommandStep(controller, controller.state.setupEditing
      ? (controller.state.project.deployCandidates?.length ?? 0) + 1
      : Number(itemId.slice(17)));
  }
  if (itemId === 'deploy-custom') return showDeployEditor(controller);
  if (itemId === 'deploy-command-continue') return onComplete();
}

export async function submitDeployEditor(controller, onComplete) {
  if (controller.state.editorContext?.purpose !== 'deploy-command') return false;
  let parsed;
  try {
    parsed = await validateCommandSpec(controller.state.project.root, controller.state.editor.value);
  } catch (error) {
    controller.setStatus(error.message);
    return true;
  }
  Object.assign(controller.state.draft.deploy, {
    commandText: parsed.commandText,
    cwd: parsed.cwd,
    name: 'Custom deployment',
    source: 'custom',
  });
  controller.message('Deploy command configured', [
    `Directory: ${commandLocationLabel(parsed.cwd)}`,
    `Command: ${parsed.commandText}`,
    deployPolicyDescription(controller.state.draft.deploy.policy),
  ], 'success');
  onComplete();
  return true;
}

export function showDeployEditor(controller) {
  controller.showEditor('deploy-command', {
    label: 'Deploy command',
    placeholder: './scripts/deploy.sh  or  web/ :: npm run deploy',
    purpose: 'deploy-command',
    instructions: [
      'Without a path, the command runs from the workspace root.',
      'Use path/ :: command to run from another directory. Tab completes the path before ::.',
      'This command runs only after every required update check passes, or when selected manually from the project menu.',
    ],
  }, controller.state.draft.deploy.source === 'custom' ? formatCommandSpec(controller.state.draft.deploy) : '');
}

export function deployPolicyDescription(value) {
  if (value === 'ask') return 'Ask whether to deploy after successful checks';
  if (value === 'always') return 'Deploy automatically after successful checks';
  if (value === 'on-demand') return 'Deployment is available after successful checks and from the project menu';
  return 'Deployment disabled';
}

function setupContinueIndex(controller, screen, index) {
  if (controller.state.setupEditing) return index;
  return controller.state.screen === screen ? null : 0;
}

function sameCommand(deploy, candidate) {
  return deploy.commandText === candidate.commandText && (deploy.cwd ?? '.') === (candidate.cwd ?? '.');
}

function choice(id, selected, label, description) {
  return { id, label: `${selected ? '●' : '○'} ${label}`, description };
}
