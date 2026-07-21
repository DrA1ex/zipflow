import { AUTONOMY_MODES, autonomyForMode, autonomyProfile } from '../autonomy/policies.js';

export function showAutonomyStep(controller) {
  const value = controller.state.draft.autonomy?.mode ?? 'manual';
  const compatible = autonomyConfigurationAvailable(controller.state);
  const items = [
    choice('autonomy-manual', value === 'manual', AUTONOMY_MODES.manual.label, AUTONOMY_MODES.manual.description),
    choice('autonomy-guarded', value === 'guarded', AUTONOMY_MODES.guarded.label, compatible
      ? AUTONOMY_MODES.guarded.description
      : 'Choose a local model and pass its autonomous decision compatibility test in Ctrl+B settings.', !compatible),
    choice('autonomy-full', value === 'full', AUTONOMY_MODES.full.label, compatible
      ? `${AUTONOMY_MODES.full.description} Protected paths and fixed safety rules remain enforced.`
      : 'Choose a local model and pass its autonomous decision compatibility test in Ctrl+B settings.', !compatible),
    { id: 'autonomy-continue', label: 'Continue', context: `Selected: ${autonomyProfile(controller.state.draft.autonomy).label}` },
  ];
  controller.showMenu('setup-autonomy', items, 'Decision mode', controller.state.setupEditing ? 3 : 0);
}

export function activateAutonomy(controller, itemId, onComplete) {
  if (itemId === 'autonomy-manual') {
    controller.state.draft.autonomy = autonomyForMode('manual');
    return showAutonomyStep(controller);
  }
  if (itemId === 'autonomy-guarded') {
    if (!autonomyConfigurationAvailable(controller.state)) return false;
    controller.state.draft.autonomy = autonomyForMode('guarded');
    return showAutonomyStep(controller);
  }
  if (itemId === 'autonomy-full') {
    if (!autonomyConfigurationAvailable(controller.state)) return false;
    controller.state.pendingAutonomyMode = 'full';
    return showFullAutonomyConfirmation(controller);
  }
  if (itemId === 'autonomy-full-confirm') {
    controller.state.draft.autonomy = autonomyForMode('full');
    controller.state.pendingAutonomyMode = null;
    return showAutonomyStep(controller);
  }
  if (itemId === 'autonomy-full-back') {
    controller.state.pendingAutonomyMode = null;
    return showAutonomyStep(controller);
  }
  if (itemId === 'autonomy-continue') return onComplete();
  return false;
}

export function showFullAutonomyConfirmation(controller) {
  controller.showMenu('setup-autonomy-confirm', [
    {
      id: 'autonomy-full-confirm',
      label: 'Enable Full autopilot · Dangerous',
      context: 'Allow risky supported decisions while retaining protected-file and command allowlist rules.',
    },
    { id: 'autonomy-full-back', label: 'Back' },
  ], 'Confirm dangerous decision mode', 1, [
    'The local LLM may keep and commit failed updates, overwrite eligible conflicts, rewrite eligible unpublished Zipflow commits, and run configured deployment.',
    'It still cannot modify protected paths, invent commands, push, force-push, or bypass transactional backups.',
  ]);
}

export function autonomyReviewLines(workflow) {
  const profile = autonomyProfile(workflow.autonomy);
  if (profile.id === 'manual') return ['  Manual', '  Zipflow asks at every unresolved decision.'];
  if (profile.id === 'guarded') return [
    '  Guarded autopilot',
    '  May resolve low-risk plan application, check retry or rollback, result commit, and deployment after successful checks.',
    '  Stops for staged work, ambiguous conflicts, failed-check commits, history rewrite, deployment after failures, or low confidence.',
  ];
  return [
    '  Full autopilot · Dangerous',
    '  May also keep and commit failed updates, choose archive/local conflict outcomes, rewrite eligible unpublished Zipflow commits, and deploy after failed checks.',
    '  Protected files, command allowlists, transactional backups, and no-push rules remain mandatory.',
  ];
}

export function autonomyConfigurationAvailable(state) {
  const settings = state.settings ?? {};
  const compatibility = settings.llmDecisionCompatibility;
  return ['ollama', 'lmstudio'].includes(settings.llmProvider)
    && Boolean(settings.llmModel)
    && compatibility?.supported === true
    && compatibility.provider === settings.llmProvider
    && compatibility.model === settings.llmModel;
}

function choice(id, selected, label, context, disabled = false) {
  return { id, label: `${selected ? '●' : '○'} ${label}`, context, disabled };
}
