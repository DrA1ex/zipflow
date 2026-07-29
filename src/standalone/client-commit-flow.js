import { setScreen } from '../app/state.js';

export function applyClientCommitSurface(controller, surface) {
  if (surface?.kind !== 'commit_choice') return false;
  const section = surface.sections?.find(({ kind }) => kind === 'commit') ?? {};
  const candidates = section.candidates?.length
    ? section.candidates
    : section.suggestedMessage
      ? [{
          id: 'suggested',
          label: 'Suggested',
          message: section.suggestedMessage,
          detail: '',
        }]
      : [];
  const resume = surface.actions?.find(({ id }) => id === 'resume-autopilot');
  setScreen(controller.state, 'commit', {
    status: 'Commit result',
    intro: [
      controller.state.run?.checks?.failed
        ? 'Required checks failed. The run will remain completed with errors.'
        : 'Git hooks follow the saved workflow policy.',
    ],
    items: [
      ...(resume ? [{
        id: 'server:resume-commit-autopilot',
        label: resume.label,
        description: resume.description,
        serverLocal: true,
      }] : []),
      ...candidates.map((candidate) => ({
        id: `server:commit-candidate:${candidate.id}`,
        label: `Create commit · ${candidate.label}`,
        description: candidate.message,
        help: candidate.detail,
        commitMessage: candidate.message,
        serverLocal: true,
      })),
      {
        id: 'server:edit-commit-message',
        label: 'Edit message…',
        description: section.suggestedMessage || 'Enter a custom commit message.',
        serverLocal: true,
      },
      {
        id: 'server:skip-commit',
        label: 'Continue without commit',
        description: 'Continue to the configured deployment step.',
        serverLocal: true,
      },
    ],
  });
  controller.invalidate();
  return true;
}

export async function activateClientCommit(controller, item) {
  if (item?.commitMessage) {
    return performCommitAction(controller, 'commit', { message: item.commitMessage });
  }
  if (item?.id === 'server:skip-commit') {
    return performCommitAction(controller, 'continue-without-commit', {});
  }
  if (item?.id === 'server:resume-commit-autopilot') {
    return performCommitAction(controller, 'resume-autopilot', {});
  }
  if (item?.id === 'server:edit-commit-message') {
    await performCommitAction(controller, 'prepare-commit', {});
    const action = controller.state.serverSurface?.actions?.find(({ id }) => id === 'commit');
    return action ? controller.activateAction(action) : undefined;
  }
  return false;
}

async function performCommitAction(controller, actionId, input) {
  const action = controller.state.serverSurface?.actions?.find(({ id }) => id === actionId);
  if (!action || action.enabled === false) {
    throw Object.assign(new Error(
      action?.disabledReason ?? `The server did not advertise ${actionId}.`,
    ), { code: 'ACTION_NOT_AVAILABLE' });
  }
  return controller.performAction(action, input);
}
