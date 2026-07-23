import { discoverProject } from '../project/detect.js';
import {
  activateProjectConfirm, activateProjectStructure, backProjectSetup, handlesProjectSetupScreen,
  hydrateConfiguredProjects, showProjectStructureStep, submitProjectSetupEditor, syncDraftProjects,
} from './setup-projects.js';
import { applyPolicyProfile, createRecommendedWorkflow } from '../workflow/defaults.js';
import { saveWorkflow } from '../workflow/store.js';
import { upsertMessage } from './state.js';
import { displayPath, parseEnteredPath } from '../utils/paths.js';
import {
  activateChecks, handleChecksShortcut, showChecksStep, submitCustomCheckEditor,
} from './setup-checks.js';
import {
  activateGitBootstrap, backGitBootstrap, handlesGitBootstrapScreen, showGitBootstrap, submitGitBootstrapEditor,
} from './setup-git-init.js';
import {
  activateDeployCommand, activateDeployPolicy, deployPolicyDescription, showDeployCommandStep,
  showDeployPolicyStep, submitDeployEditor,
} from './setup-deploy.js';
import { activateAutonomy, autonomyReviewLines, showAutonomyStep } from './setup-autonomy.js';

export async function beginSetup(controller, { fresh = false } = {}) {
  const { state } = controller;
  state.setupEditing = Boolean(state.workflow && !fresh);
  await hydrateConfiguredProjects(controller);
  state.draft = fresh || !state.workflow ? createRecommendedWorkflow(state.project) : structuredClone(state.workflow);
  syncDraftProjects(controller);
  controller.message(fresh ? 'Starting a new workflow' : 'Reviewing workflow', [
    'Zipflow inspected the project and prepared a recommended workflow.',
    'The next steps let you confirm which checks run, how archives replace files, and what Git or deployment actions happen after a successful update.',
    'Recommended choices are already selected. Change only the parts that differ from how this project is normally maintained.',
    'Nothing replaces the saved workflow until you review and confirm the final summary.',
  ]);
  if (state.setupEditing) showWorkflowSections(controller);
  else showProjectStructureStep(controller);
}

export function handlesSetupScreen(screen) {
  return handlesGitBootstrapScreen(screen) || handlesProjectSetupScreen(screen) || screen.startsWith('setup-') || screen.startsWith('custom-check') || [
    'project-path-input', 'commit-template', 'deploy-command',
  ].includes(screen);
}

export async function activateSetup(controller, itemId) {
  const { screen } = controller.state;
  if (handlesGitBootstrapScreen(screen)) return activateGitBootstrap(controller, itemId);
  if (screen === 'setup-sections') return activateWorkflowSection(controller, itemId);
  if (screen === 'setup-project') return activateProject(controller, itemId);
  if (screen === 'setup-project-confirm' || screen === 'setup-project-type') return activateProjectConfirm(controller, itemId);
  if (screen === 'setup-checks') return activateChecks(controller, itemId, () => finishSetupSection(controller, () => showPolicyStep(controller)));
  if (screen === 'setup-policy') return activatePolicy(controller, itemId);
  if (screen === 'setup-autonomy' || screen === 'setup-autonomy-confirm') return activateAutonomy(controller, itemId, () => finishSetupSection(controller, () => showArchiveModeStep(controller)));
  if (screen === 'setup-archive-mode') return activateArchiveMode(controller, itemId);
  if (screen === 'setup-deletion-scope') return activateDeletionScope(controller, itemId);
  if (screen === 'setup-git-checkpoint') return activateCheckpoint(controller, itemId);
  if (screen === 'setup-git-result') return activateResultCommit(controller, itemId);
  if (screen === 'setup-git-message') return activateMessageStrategy(controller, itemId);
  if (screen === 'setup-deploy') return activateDeployPolicy(controller, itemId, () => finishSetupSection(controller, () => showReviewStep(controller)));
  if (screen === 'setup-deploy-command') return activateDeployCommand(controller, itemId, () => finishSetupSection(controller, () => showReviewStep(controller)));
  if (screen === 'setup-review') return activateReview(controller, itemId);
}

export async function submitSetupEditor(controller) {
  const { state } = controller;
  const purpose = state.editorContext?.purpose;
  if (purpose === 'setup-project-path') return submitProjectPath(controller);
  if (purpose === 'setup-project-entry-path') return submitProjectSetupEditor(controller);
  if (await submitGitBootstrapEditor(controller)) return;
  if (await submitCustomCheckEditor(controller)) return;
  if (purpose === 'commit-template') {
    const template = state.editor.value.trim();
    if (!template) return controller.setStatus('Enter a commit message template.');
    state.draft.git.fixedMessage = template;
    controller.message('Commit template saved', [template], 'success');
    return finishSetupSection(controller, () => showDeployPolicyStep(controller));
  }
  if (purpose === 'deploy-command') return await submitDeployEditor(controller, () => finishSetupSection(controller, () => showReviewStep(controller)));
}

export function handleSetupShortcut(controller, key) {
  return handleChecksShortcut(controller, key);
}

export function backSetup(controller) {
  const screen = controller.state.screen;
  if (backProjectSetup(controller)) return;
  if (handlesGitBootstrapScreen(screen)) {
    const handled = backGitBootstrap(controller);
    if (handled !== false) return handled;
    return showProjectStructureStep(controller);
  }
  if (screen === 'setup-sections') return controller.showHome();
  if (screen === 'setup-project') return isEditingSection(controller, 'project') ? showWorkflowSections(controller) : controller.showHome();
  if (screen === 'setup-checks') return isEditingSection(controller, 'checks') ? showWorkflowSections(controller) : showProjectStructureStep(controller);
  if (screen === 'setup-policy') return isEditingSection(controller, 'policy') ? showWorkflowSections(controller) : showChecksStep(controller);
  if (screen === 'setup-autonomy') return isEditingSection(controller, 'autonomy') ? showWorkflowSections(controller) : showPolicyStep(controller);
  if (screen === 'setup-autonomy-confirm') return showAutonomyStep(controller);
  if (screen === 'setup-archive-mode') return isEditingSection(controller, 'archive') ? showWorkflowSections(controller) : showAutonomyStep(controller);
  if (screen === 'setup-deletion-scope') return showArchiveModeStep(controller);
  if (screen === 'setup-git-checkpoint') return isEditingSection(controller, 'git') ? showWorkflowSections(controller) : previousBeforeCheckpoint(controller);
  if (screen === 'setup-git-result') return showCheckpointStep(controller);
  if (screen === 'setup-git-message') return showResultCommitStep(controller);
  if (screen === 'setup-deploy') return isEditingSection(controller, 'deploy') ? showWorkflowSections(controller) : previousBeforeDeploy(controller);
  if (screen === 'setup-deploy-command') return showDeployPolicyStep(controller);
  if (screen === 'setup-review') return controller.state.setupEditing ? showWorkflowSections(controller, 'review') : showDeployPolicyStep(controller);
  if (screen.startsWith('custom-check')) return showChecksStep(controller);
  if (screen === 'project-path-input') return showProjectStructureStep(controller);
  if (screen === 'commit-template') return showMessageStrategyStep(controller);
  if (screen === 'deploy-command') return showDeployCommandStep(controller);
}

async function activateProject(controller, itemId) {
  if (itemId === 'choose-project') return controller.showEditor('project-path-input', {
    label: 'Project directory',
    placeholder: controller.state.project.root,
    purpose: 'setup-project-path',
    instructions: ['Enter the project directory. Tab completes directory names.'],
  }, controller.state.project.root);
  return activateProjectStructure(controller, itemId, () => {
    if (isEditingSection(controller, 'project')) return showWorkflowSections(controller);
    return controller.state.project.git ? showChecksStep(controller) : showGitBootstrap(controller);
  });
}

async function submitProjectPath(controller) {
  const { state } = controller;
  const target = parseEnteredPath(state.editor.value, state.project.root);
  try {
    state.project = await discoverProject(target);
    state.draft = createRecommendedWorkflow(state.project);
    controller.message('Project selected', [displayPath(state.project.root), detectedLine(state.project)], 'success');
    showProjectStructureStep(controller);
  } catch (error) {
    controller.message('Could not use this directory', [error.message], 'error');
  }
}


function showWorkflowSections(controller, selectedSection = null) {
  const workflow = controller.state.draft;
  const returnSection = selectedSection ?? controller.state.setupSection;
  controller.state.setupSection = null;
  const selectedChecks = workflow.checks.filter((check) => check.selected).length;
  const items = [
    { id: 'section-project', label: 'Project structure', description: `${displayPath(controller.state.project.root)} · ${detectedLine(controller.state.project)}` },
    { id: 'section-checks', label: 'Checks', description: `${selectedChecks} selected check${selectedChecks === 1 ? '' : 's'}` },
    { id: 'section-policy', label: 'Update policy', description: workflow.policy.label },
    { id: 'section-autonomy', label: 'Decision mode', description: workflow.autonomy?.mode === 'full' ? 'Full autopilot · Dangerous' : workflow.autonomy?.mode === 'guarded' ? 'Guarded autopilot' : 'Manual' },
    { id: 'section-archive', label: 'Archive mode', description: workflow.archive.mode === 'overlay' ? 'Overlay · missing files stay untouched' : deletionReviewLabel(workflow.deletion.scope) },
    ...(controller.state.project.git ? [{ id: 'section-git', label: 'Git', description: `${checkpointLabel(workflow.git.checkpoint)} · ${resultCommitLabel(workflow.git.resultCommit)}` }] : []),
    { id: 'section-deploy', label: 'Deployment', description: deployPolicyDescription(workflow.deploy.policy) },
    { id: 'section-review', label: 'Review and save', description: 'Review every section before replacing the active workflow' },
    { id: 'section-cancel', label: 'Cancel', description: 'Keep the currently saved workflow unchanged' },
  ];
  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === `section-${returnSection}`));
  controller.showMenu('setup-sections', items, 'Edit workflow', selectedIndex, ['Changes remain in a draft until Review and save succeeds.']);
}

function activateWorkflowSection(controller, itemId) {
  if (itemId === 'section-cancel') return controller.showHome();
  if (itemId === 'section-review') return showReviewStep(controller);
  if (!itemId.startsWith('section-')) return;
  return openWorkflowSection(controller, itemId.slice(8));
}

function openWorkflowSection(controller, section) {
  controller.state.setupSection = section;
  if (section === 'project') return showProjectStructureStep(controller);
  if (section === 'checks') return showChecksStep(controller);
  if (section === 'policy') return showPolicyStep(controller);
  if (section === 'autonomy') return showAutonomyStep(controller);
  if (section === 'archive') return showArchiveModeStep(controller);
  if (section === 'git') return showCheckpointStep(controller);
  if (section === 'deploy') return showDeployPolicyStep(controller);
}

function isEditingSection(controller, section) {
  return Boolean(controller.state.setupEditing && controller.state.setupSection === section);
}

function finishSetupSection(controller, fallback) {
  if (controller.state.setupEditing && controller.state.setupSection) return showWorkflowSections(controller);
  return fallback();
}

function showPolicyStep(controller) {
  const workflow = controller.state.draft;
  controller.showMenu('setup-policy', [
    choice('profile-safe', workflow.policy.id === 'safe', 'Safe', 'Review every archive plan and ask before overwriting local changes.'),
    choice('profile-practical', workflow.policy.id === 'practical', 'Practical', 'Apply safe plans automatically and ask only when local work is affected.'),
    choice('profile-trust', workflow.policy.id === 'trust', 'Trust archive', 'Back up and overwrite conflicting local files without asking each time.'),
    { id: 'policy-continue', label: 'Continue', description: `Selected: ${workflow.policy.label}` },
  ], 'Conflict and confirmation policy', setupContinueIndex(controller, 'setup-policy', 3));
}

function activatePolicy(controller, itemId) {
  if (itemId.startsWith('profile-')) {
    applyPolicyProfile(controller.state.draft, itemId.slice(8));
    return showPolicyStep(controller);
  }
  if (itemId === 'policy-continue') return finishSetupSection(controller, () => showAutonomyStep(controller));
}

function showArchiveModeStep(controller) {
  const mode = controller.state.draft.archive.mode;
  controller.showMenu('setup-archive-mode', [
    choice('archive-overlay', mode === 'overlay', 'Overlay archive', 'Add and update files from the ZIP. Files missing from the ZIP stay untouched.'),
    choice('archive-snapshot', mode === 'snapshot', 'Full project snapshot', 'Treat the ZIP as the complete managed project. Missing files may be removed.'),
    { id: 'archive-continue', label: 'Continue', description: mode === 'overlay' ? 'No files are deleted because they are absent from the archive.' : 'You will choose exactly which missing files may be deleted next.' },
  ], 'How should this archive be interpreted?', setupContinueIndex(controller, 'setup-archive-mode', 2));
}

function activateArchiveMode(controller, itemId) {
  if (itemId === 'archive-overlay' || itemId === 'archive-snapshot') {
    controller.state.draft.archive.mode = itemId === 'archive-overlay' ? 'overlay' : 'snapshot';
    return showArchiveModeStep(controller);
  }
  if (itemId === 'archive-continue') {
    if (controller.state.draft.archive.mode === 'snapshot') return showDeletionScopeStep(controller);
    return finishSetupSection(controller, () => showAfterArchiveSettings(controller));
  }
}

function showDeletionScopeStep(controller) {
  const recording = controller.state.settings?.managedHistoryPolicy !== 'disabled';
  if (!recording && controller.state.draft.deletion.scope === 'managed-history') controller.state.draft.deletion.scope = 'tracked-only';
  const scope = controller.state.draft.deletion.scope;
  const managed = choice('delete-managed', scope === 'managed-history', 'Only files previously managed by Zipflow',
    recording
      ? 'Delete a missing file only if an earlier Zipflow run created or updated it.'
      : 'Enable managed-file recording in Ctrl+B settings before using this deletion policy.');
  managed.disabled = !recording;
  controller.showMenu('setup-deletion-scope', [
    choice('delete-tracked', scope === 'tracked-only', 'Only clean Git-tracked files', 'Delete a missing file only when Git tracks it and it has no local changes. Untracked local files are kept and reported.'),
    managed,
    choice('delete-all', scope === 'all', 'All files in the managed scope', 'Also delete untracked files missing from the archive. Protected and excluded paths are still kept.'),
    { id: 'deletion-continue', label: 'Continue', description: deletionScopeDescription(scope) },
  ], 'Which missing files may snapshot mode delete?', setupContinueIndex(controller, 'setup-deletion-scope', 3));
}

function activateDeletionScope(controller, itemId) {
  if (itemId === 'delete-managed' && controller.state.settings?.managedHistoryPolicy === 'disabled') {
    controller.toast('Enable managed-file recording first', 'warning');
    return showDeletionScopeStep(controller);
  }
  if (['delete-tracked', 'delete-managed', 'delete-all'].includes(itemId)) {
    controller.state.draft.deletion.scope = itemId === 'delete-tracked' ? 'tracked-only' : itemId === 'delete-managed' ? 'managed-history' : 'all';
    return showDeletionScopeStep(controller);
  }
  if (itemId === 'deletion-continue') return finishSetupSection(controller, () => showAfterArchiveSettings(controller));
}

function showCheckpointStep(controller) {
  const value = controller.state.draft.git.checkpoint;
  controller.showMenu('setup-git-checkpoint', [
    choice('checkpoint-never', value === 'never', 'Do not create checkpoint commits', 'Zipflow still creates its file backup before applying the archive.'),
    choice('checkpoint-ask', value === 'ask', 'Ask when local work would be overwritten', 'Offer a checkpoint commit only when an archive conflicts with uncommitted files.'),
    choice('checkpoint-auto', value === 'auto', 'Create checkpoint automatically when needed', 'Commit the affected local files before Zipflow replaces them with archive versions.'),
    { id: 'checkpoint-continue', label: 'Continue', description: `Selected: ${checkpointLabel(value)}` },
  ], 'Protect conflicting local work with Git', setupContinueIndex(controller, 'setup-git-checkpoint', 3));
}

function activateCheckpoint(controller, itemId) {
  const value = itemId.replace('checkpoint-', '');
  if (['never', 'ask', 'auto'].includes(value)) {
    controller.state.draft.git.checkpoint = value;
    return showCheckpointStep(controller);
  }
  if (itemId === 'checkpoint-continue') return showResultCommitStep(controller);
}

function showResultCommitStep(controller) {
  const value = controller.state.draft.git.resultCommit;
  controller.showMenu('setup-git-result', [
    choice('result-never', value === 'never', 'Do not commit the applied update', 'Leave the successfully checked files in the working tree.'),
    choice('result-ask', value === 'ask', 'Ask after successful checks', 'Show the proposed message and let you create or skip the commit.'),
    choice('result-auto', value === 'auto', 'Commit automatically after successful checks', 'Commit only the files applied by this Zipflow run.'),
    { id: 'result-continue', label: 'Continue', description: `Selected: ${resultCommitLabel(value)}` },
  ], 'Commit the successfully checked update', setupContinueIndex(controller, 'setup-git-result', 3));
}

function activateResultCommit(controller, itemId) {
  const value = itemId.replace('result-', '');
  if (['never', 'ask', 'auto'].includes(value)) {
    controller.state.draft.git.resultCommit = value;
    return showResultCommitStep(controller);
  }
  if (itemId === 'result-continue') {
    if (controller.state.draft.git.resultCommit === 'never') return finishSetupSection(controller, () => showDeployPolicyStep(controller));
    return showMessageStrategyStep(controller);
  }
}

function showMessageStrategyStep(controller) {
  const value = controller.state.draft.git.messageStrategy;
  controller.showMenu('setup-git-message', [
    choice('message-metadata', value === 'metadata', 'Read message from the archive', 'Use .zipflow/commit-message.txt first, with legacy filenames supported for compatibility. Fall back to the run identifier.'),
    choice('message-llm', value === 'llm', 'Generate with the configured local LLM', localLlmMessageDescription(controller.state)),
    choice('message-generated', value === 'generated', 'Generated run identifier', 'Example: zipflow: apply zf-20260719-7C2F'),
    choice('message-archive', value === 'archive', 'Archive filename', 'Example: Apply project-update.zip'),
    choice('message-fixed', value === 'fixed', 'Fixed template', controller.state.draft.git.fixedMessage),
    { id: 'message-continue', label: 'Continue', description: messageStrategyLabel(value) },
  ], 'Choose the result commit message source', setupContinueIndex(controller, 'setup-git-message', 5));
}

function activateMessageStrategy(controller, itemId) {
  if (itemId.startsWith('message-') && itemId !== 'message-continue') {
    controller.state.draft.git.messageStrategy = itemId.slice(8);
    return showMessageStrategyStep(controller);
  }
  if (itemId === 'message-continue') {
    if (controller.state.draft.git.messageStrategy === 'fixed') {
      return controller.showEditor('commit-template', {
        label: 'Commit message template',
        placeholder: 'zipflow: apply {runId}',
        purpose: 'commit-template',
        instructions: ['Available values: {runId}, {archiveName}, {projectName}, {date}, {time}.'],
      }, controller.state.draft.git.fixedMessage);
    }
    return finishSetupSection(controller, () => showDeployPolicyStep(controller));
  }
}

function showReviewStep(controller) {
  const workflow = controller.state.draft;
  const actionLabel = controller.state.workflow ? 'Replace existing workflow' : 'Save workflow';
  upsertMessage(controller.state, 'workflow-review-draft', 'Workflow review', workflowReviewLines(controller.state, workflow), 'summary', {
    collapsible: true,
    collapsed: false,
    collapsedSummary: `${workflow.checks.filter((check) => check.selected).length} checks · ${workflow.policy.label} · ${workflow.archive.mode === 'overlay' ? 'overlay' : 'snapshot'}`,
  });
  controller.showMenu('setup-review', [
    { id: 'save-workflow', label: actionLabel, description: 'Save this complete configuration and make it active for the next update.' },
    { id: 'review-back', label: 'Back', description: 'Return to workflow sections without discarding the draft.' },
  ], 'Review workflow', 0);
}

async function activateReview(controller, itemId) {
  if (itemId === 'review-back') {
    return controller.state.setupEditing ? showWorkflowSections(controller, 'review') : showDeployPolicyStep(controller);
  }
  if (itemId === 'save-workflow') {
    controller.state.workflow = await saveWorkflow(controller.state.draft);
    controller.state.draft = null;
    upsertMessage(controller.state, 'workflow-review-draft', 'Workflow saved', [controller.state.workflow.name], 'success', { collapsible: false, collapsed: false });
    const { beginArchiveInput } = await import('./run-flow.js');
    beginArchiveInput(controller);
  }
}

function workflowReviewLines(state, workflow) {
  const selectedChecks = workflow.checks.filter((check) => check.selected);
  const lines = [
    'PROJECT',
    `  ${displayPath(state.project.root)}`,
    `  ${detectedLine(state.project)}`,
    ...projectReviewLines(workflow),
    '',
    'CHECKS',
    `  ${selectedChecks.length} enabled`,
    ...selectedChecks.map((check) => `  • ${(check.cwd ?? '.') === '.' ? 'Root' : `${check.cwd}/`} · ${check.name}${check.commandText ? ` · ${check.commandText}` : ''}`),
    '',
    'UPDATE POLICY',
    `  ${workflow.policy.label}`,
    `  ${policyReviewDescription(workflow.policy.id)}`,
    '',
    'DECISION MODE',
    ...autonomyReviewLines(workflow),
    '',
    'ARCHIVE INTERPRETATION',
    `  ${workflow.archive.mode === 'overlay' ? 'Overlay archive' : 'Full project snapshot'}`,
    `  ${archiveReviewDescription(workflow)}`,
  ];
  if (state.project.git) lines.push(
    '',
    'GIT',
    `  Checkpoint: ${checkpointLabel(workflow.git.checkpoint)}`,
    `  Result commit: ${resultCommitLabel(workflow.git.resultCommit)}`,
    ...(workflow.git.resultCommit === 'never' ? [] : [`  Message: ${messageStrategyLabel(workflow.git.messageStrategy)}`]),
  );
  else lines.push('', 'GIT', '  Repository not initialized · Zipflow file backups remain enabled');
  lines.push(
    '',
    'DEPLOYMENT',
    `  ${deployPolicyDescription(workflow.deploy.policy)}`,
    ...(workflow.deploy.commandText ? [`  Directory: ${(workflow.deploy.cwd ?? '.') === '.' ? 'Root' : `${workflow.deploy.cwd}/`}`, `  Command: ${workflow.deploy.commandText}`] : []),
  );
  return lines;
}

function policyReviewDescription(value) {
  if (value === 'safe') return 'Review every plan and ask before replacing local changes.';
  if (value === 'trust') return 'Back up and replace conflicts without an additional confirmation.';
  return 'Apply safe plans directly and ask only when local work is affected.';
}

function archiveReviewDescription(workflow) {
  if (workflow.archive.mode === 'overlay') return 'Files from the ZIP are added or updated; missing local files stay untouched.';
  return deletionScopeDescription(workflow.deletion.scope);
}

function previousBeforeCheckpoint(controller) {
  return controller.state.draft.archive.mode === 'snapshot' ? showDeletionScopeStep(controller) : showArchiveModeStep(controller);
}

function previousBeforeDeploy(controller) {
  if (!controller.state.project.git) return previousBeforeCheckpoint(controller);
  return controller.state.draft.git.resultCommit === 'never' ? showResultCommitStep(controller) : showMessageStrategyStep(controller);
}

function showAfterArchiveSettings(controller) {
  return controller.state.project.git ? showCheckpointStep(controller) : showDeployPolicyStep(controller);
}


function setupContinueIndex(controller, screen, index) {
  if (controller.state.setupEditing) return index;
  return controller.state.screen === screen ? null : 0;
}

function choice(id, selected, label, description) {
  return { id, label: `${selected ? '●' : '○'} ${label}`, description };
}

function detectedLine(project) {
  const active = project.activeProjects ?? project.projects?.filter((entry) => entry.selected !== false) ?? [];
  const labels = project.workspaceLabels ?? project.labels ?? [];
  const projectCount = active.length || 1;
  const structure = projectCount > 1 ? `${projectCount} projects · ` : '';
  return `${structure}${labels.join(' · ') || 'Unknown type'}${project.git ? ' · Git' : ''}`;
}

function projectReviewLines(workflow) {
  const projects = workflow.projects ?? [];
  if (!projects.length) return [];
  return projects.filter((entry) => entry.selected !== false).map((entry) => {
    const location = entry.path === '.' ? 'Root' : `${entry.path}/`;
    return `  • ${location} · ${entry.labels?.join(' · ') || 'Ordinary project'}`;
  });
}

function checkpointLabel(value) {
  if (value === 'auto') return 'Automatic when conflicting local work is affected';
  if (value === 'never') return 'No checkpoint commit';
  return 'Ask when conflicting local work is affected';
}

function resultCommitLabel(value) {
  if (value === 'auto') return 'Automatic after successful checks';
  if (value === 'never') return 'No result commit';
  return 'Ask after successful checks';
}

function messageStrategyLabel(value) {
  if (value === 'metadata') return 'Archive metadata file, then generated fallback';
  if (value === 'llm') return 'Local LLM, then archive metadata and generated fallback';
  if (value === 'archive') return 'Archive filename';
  if (value === 'fixed') return 'Fixed template';
  return 'Generated run identifier';
}

function localLlmMessageDescription(state) {
  if (state.settings?.llmProvider !== 'disabled' && state.settings?.llmModel) {
    return `Use ${state.settings.llmProvider} · ${state.settings.llmModel} to analyze changes.patch. Fall back to archive metadata, then the run identifier.`;
  }
  return 'Configure a provider and model in Ctrl+B settings. Until then Zipflow falls back to archive metadata, then the run identifier.';
}


function deletionReviewLabel(scope) {
  if (scope === 'all') return 'Snapshot · all managed files';
  if (scope === 'managed-history') return 'Snapshot · files previously managed by Zipflow';
  return 'Snapshot · clean Git-tracked files only';
}

function deletionScopeDescription(scope) {
  if (scope === 'all') return 'More destructive: all non-protected missing files can be removed.';
  if (scope === 'managed-history') return 'Only paths recorded from earlier successful Zipflow applications may be removed.';
  return 'Safer Git default: untracked local files remain in place.';
}
