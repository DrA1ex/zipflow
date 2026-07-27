import { canonicalModelId } from '../llm/model-identity.js';
import {
  AUTONOMY_MODES, FULL_AUTOPILOT_WARNING_VERSION, autonomyForMode, autonomyProfile,
} from '../autonomy/policies.js';

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
    controller.state.draft.autonomy = autonomyWithMode(controller.state.draft.autonomy, 'manual');
    return showAutonomyStep(controller);
  }
  if (itemId === 'autonomy-guarded') {
    if (!autonomyConfigurationAvailable(controller.state)) return false;
    controller.state.draft.autonomy = autonomyWithMode(controller.state.draft.autonomy, 'guarded');
    return showAutonomyStep(controller);
  }
  if (itemId === 'autonomy-full') {
    if (!autonomyConfigurationAvailable(controller.state)) return false;
    if (Number(controller.state.draft.autonomy?.fullWarningAcknowledgedVersion ?? 0) >= FULL_AUTOPILOT_WARNING_VERSION) {
      controller.state.draft.autonomy = autonomyWithMode(controller.state.draft.autonomy, 'full');
      return showAutonomyStep(controller);
    }
    controller.state.pendingAutonomyMode = 'full';
    return showFullAutonomyConfirmation(controller);
  }
  if (itemId === 'autonomy-full-confirm') {
    controller.state.draft.autonomy = {
      ...autonomyWithMode(controller.state.draft.autonomy, 'full'),
      fullWarningAcknowledgedVersion: FULL_AUTOPILOT_WARNING_VERSION,
    };
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
    'Full autopilot sends project and run context to a local model as untrusted decision input. The model can misunderstand the change, return an incorrect decision, or overlook a risk.',
    'It may keep and commit failed updates, overwrite eligible conflicts, rewrite eligible unpublished Zipflow commits, and run the configured deployment command.',
    'Deterministic checks, protected paths, explicit command configuration, transactional backups, and no-push rules remain authoritative and cannot be bypassed by the model.',
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
    '  Model decisions can be wrong; deterministic checks and fixed safety rules remain authoritative.',
    '  Protected files, configured commands, transactional backups, and no-push rules remain mandatory.',
  ];
}

export function autonomyConfigurationAvailable(state) {
  const settings = state.settings ?? {};
  const compatibility = settings.llmDecisionCompatibility;
  const configuredModel = canonicalModelId(settings.llmProvider, settings.llmModel);
  const testedModel = canonicalModelId(compatibility?.provider, compatibility?.model);
  return ['ollama', 'lmstudio', 'openai'].includes(settings.llmProvider)
    && Boolean(configuredModel)
    && compatibility?.supported === true
    && compatibility.provider === settings.llmProvider
    && testedModel === configuredModel;
}

function choice(id, selected, label, context, disabled = false) {
  return { id, label: `${selected ? '●' : '○'} ${label}`, context, disabled };
}

function autonomyWithMode(current, mode) {
  return {
    ...autonomyForMode(mode),
    fullWarningAcknowledgedVersion: Number(current?.fullWarningAcknowledgedVersion ?? 0),
  };
}
