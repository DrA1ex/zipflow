import path from 'node:path';
import { exists } from '../utils/fs.js';
import { configureWorkspaceProjects, discoverProject } from '../project/detect.js';
import { addRecommendedGitignore, recommendedGitignoreGroups } from '../git/ignore.js';
import { createInitialCommit, initializeRepository, prepareInitialCommit } from '../git/repository.js';
import { showChecksStep } from './setup-checks.js';

export function handlesGitBootstrapScreen(screen) {
  return ['setup-git-init', 'setup-gitignore', 'setup-initial-commit', 'setup-initial-commit-review', 'initial-commit-message'].includes(screen);
}

export function showGitBootstrap(controller) {
  controller.showMenu('setup-git-init', [
    {
      id: 'git-init',
      label: 'Initialize Git for this project',
      description: 'Create a local repository, then configure ignore rules and offer a first commit.',
    },
    {
      id: 'git-skip',
      label: 'Continue without Git',
      description: 'Backups still work, but Zipflow cannot distinguish local edits from archive changes as precisely.',
    },
  ], 'Git is not initialized');
}

export async function activateGitBootstrap(controller, itemId) {
  if (controller.state.screen === 'setup-git-init') return activateInit(controller, itemId);
  if (controller.state.screen === 'setup-gitignore') return activateGitignore(controller, itemId);
  if (controller.state.screen === 'setup-initial-commit') return activateInitialCommit(controller, itemId);
  if (controller.state.screen === 'setup-initial-commit-review') return activateInitialCommitReview(controller, itemId);
}

export async function submitGitBootstrapEditor(controller) {
  if (controller.state.editorContext?.purpose !== 'initial-commit-message') return false;
  const message = controller.state.editor.value.trim();
  if (!message) {
    controller.setStatus('Enter a message for the first commit.');
    return true;
  }
  await createFirstCommit(controller, message);
  return true;
}

export function backGitBootstrap(controller) {
  const screen = controller.state.screen;
  if (screen === 'setup-git-init') return false;
  if (screen === 'setup-gitignore') return showChecksStep(controller);
  if (screen === 'setup-initial-commit-review') return showInitialCommitStep(controller);
  if (screen === 'setup-initial-commit' || screen === 'initial-commit-message') return showGitignoreStep(controller);
  return false;
}

async function activateInit(controller, itemId) {
  if (itemId === 'git-skip') {
    controller.state.draft.git.checkpoint = 'never';
    controller.state.draft.git.resultCommit = 'never';
    controller.message('Continuing without Git', [
      'Zipflow will still back up every affected file before applying an archive.',
      'Conflicting existing files require more conservative decisions because there is no committed baseline.',
    ], 'warning');
    return showChecksStep(controller);
  }
  if (itemId !== 'git-init') return;
  const result = await initializeRepository(controller.state.project.root);
  if (!result.ok) {
    controller.message('Git initialization failed', [result.reason], 'error');
    return showGitBootstrap(controller);
  }
  controller.state.project = await configureWorkspaceProjects(
    await discoverProject(controller.state.project.root),
    controller.state.draft.projects,
  );
  controller.state.draft.projectPath = controller.state.project.root;
  controller.message('Git repository initialized', [controller.state.project.root], 'success');
  return showGitignoreStep(controller);
}

async function showGitignoreStep(controller) {
  const target = path.join(controller.state.project.root, '.gitignore');
  const existsAlready = await exists(target);
  const patternCount = recommendedGitignoreGroups(controller.state.project)
    .reduce((total, group) => total + group.patterns.length, 0);
  if (existsAlready) {
    controller.showMenu('setup-gitignore', [
      {
        id: 'gitignore-existing',
        label: 'Use the existing .gitignore unchanged',
        description: 'Zipflow never rewrites or appends to an existing .gitignore.',
      },
      {
        id: 'gitignore-view',
        label: 'Review recommended groups only',
        description: 'Show suggestions in Activity without changing the existing file.',
      },
    ], 'Existing .gitignore found');
    return;
  }
  controller.showMenu('setup-gitignore', [
    {
      id: 'gitignore-add',
      label: 'Create a recommended .gitignore',
      description: `${patternCount} base and project-specific rules for caches, metadata, IDE files, build output, and local settings.`,
    },
    {
      id: 'gitignore-view',
      label: 'Review recommended groups',
      description: 'Show the categories in Activity before deciding.',
    },
    { id: 'gitignore-skip', label: 'Continue without creating .gitignore' },
  ], 'Protect local and generated files');
}

async function activateGitignore(controller, itemId) {
  if (itemId === 'gitignore-view') {
    controller.message('Recommended .gitignore groups', recommendedGitignoreGroups(controller.state.project).map((group) => `${group.title}: ${group.patterns.join(', ')}`));
    return showGitignoreStep(controller);
  }
  if (itemId === 'gitignore-add') {
    const result = await addRecommendedGitignore(controller.state.project);
    controller.message(result.created ? '.gitignore created' : 'Existing .gitignore kept unchanged', [
      result.created
        ? `${result.addedCount} recommended rules were written to the new file.`
        : 'The file appeared before creation completed, so Zipflow left it untouched.',
    ], 'success');
    return showInitialCommitStep(controller);
  }
  if (itemId === 'gitignore-existing' || itemId === 'gitignore-skip') return showInitialCommitStep(controller);
}

function showInitialCommitStep(controller) {
  controller.showMenu('setup-initial-commit', [
    {
      id: 'initial-commit-default',
      label: 'Review current files and create the first commit',
      description: 'Enumerate committable files, exclude protected paths, and require a decision for files that may contain secrets or private data.',
    },
    {
      id: 'initial-commit-edit',
      label: 'Create the first commit with another message',
      description: 'Enter the commit message before adding the current project files.',
    },
    {
      id: 'initial-commit-skip',
      label: 'Skip the first commit',
      description: 'The repository remains initialized, but files stay uncommitted.',
    },
  ], 'Create the Git baseline');
}

async function activateInitialCommit(controller, itemId) {
  if (itemId === 'initial-commit-skip') return showChecksStep(controller);
  if (itemId === 'initial-commit-edit') {
    return controller.showEditor('initial-commit-message', {
      label: 'First commit message',
      placeholder: 'Initial commit',
      purpose: 'initial-commit-message',
      instructions: ['Zipflow will enumerate current files and require explicit review of paths that may contain secrets or private data.'],
    }, 'Initial commit');
  }
  if (itemId === 'initial-commit-default') return createFirstCommit(controller, 'Initial commit');
}

async function createFirstCommit(controller, message) {
  const prepared = await prepareInitialCommit(controller.state.project.root);
  if (!prepared.ok) {
    controller.message('First commit was not prepared', [prepared.reason], 'error');
    return showInitialCommitStep(controller);
  }
  if (!prepared.paths.length) {
    controller.message('First commit was not created', ['There are no committable project files.'], 'warning');
    return showInitialCommitStep(controller);
  }
  controller.state.initialCommitDraft = { message, ...prepared };
  if (prepared.sensitive.length) return showInitialCommitReview(controller);
  return commitPreparedInitialFiles(controller, prepared.approvedPaths);
}

function showInitialCommitReview(controller) {
  const draft = controller.state.initialCommitDraft;
  const credentialFiles = draft.sensitive.filter((item) => item.risk === 'credential');
  const reviewFiles = draft.sensitive.filter((item) => item.risk !== 'credential');
  controller.message('First commit exclusions', [
    `${draft.paths.length} candidate files · ${draft.sensitive.length} excluded by default`,
    ...(credentialFiles.length ? [`Credentials or private keys (${credentialFiles.length}):`] : []),
    ...credentialFiles.slice(0, 8).map((item) => `  ${item.path} · ${item.reason}`),
    ...(reviewFiles.length ? [`Local, generated, database, or large files (${reviewFiles.length}):`] : []),
    ...reviewFiles.slice(0, 8).map((item) => `  ${item.path} · ${item.reason}`),
    ...(draft.sensitive.length > 16 ? [`…and ${draft.sensitive.length - 16} more excluded files`] : []),
    'Nothing is staged until you choose. You can keep these exclusions or explicitly override them and include every listed file.',
  ], 'warning');
  controller.showMenu('setup-initial-commit-review', [
    {
      id: 'initial-review-exclude',
      label: 'Keep listed files excluded and create commit',
      description: draft.approvedPaths.length
        ? `${draft.approvedPaths.length} unflagged files will be staged explicitly.`
        : 'No unflagged files are available for this commit.',
      disabled: draft.approvedPaths.length === 0,
      disabledReason: 'Review and include at least one flagged file, or skip the first commit.',
    },
    {
      id: 'initial-review-include',
      label: 'Override exclusions and include all listed files',
      description: 'Explicitly include every listed credential, private-data, generated, database, and large file in the first commit.',
    },
    { id: 'initial-review-back', label: 'Back', description: 'Return without staging files.' },
  ], 'Review files before the first commit', 0, [
    'Protected .git and .zipflow paths are never included. Existing .gitignore rules remain authoritative.',
  ]);
}

async function activateInitialCommitReview(controller, itemId) {
  const draft = controller.state.initialCommitDraft;
  if (!draft || itemId === 'initial-review-back') return showInitialCommitStep(controller);
  if (itemId === 'initial-review-exclude') return commitPreparedInitialFiles(controller, draft.approvedPaths);
  if (itemId === 'initial-review-include') return commitPreparedInitialFiles(controller, draft.paths);
}

async function commitPreparedInitialFiles(controller, paths) {
  const draft = controller.state.initialCommitDraft;
  const result = await createInitialCommit(controller.state.project.root, draft.message, { paths, allowHooks: false });
  if (!result.ok) {
    controller.message('First commit was not created', [result.reason, 'You can retry, change the message, or skip this step.'], 'error');
    return draft.sensitive?.length ? showInitialCommitReview(controller) : showInitialCommitStep(controller);
  }
  controller.state.initialCommitDraft = null;
  controller.message('First commit created', [
    `${result.revision} ${draft.message}`,
    `${result.paths.length} files added to the Git baseline.`,
    ...(result.omittedPaths?.length ? [`${result.omittedPaths.length} listed files were deliberately excluded from the commit: ${result.omittedPaths.slice(0, 6).join(', ')}${result.omittedPaths.length > 6 ? ', …' : ''}`] : []),
    'Git hooks were disabled for this Zipflow commit.',
  ], 'success');
  showChecksStep(controller);
}
