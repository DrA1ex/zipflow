import path from 'node:path';
import { exists } from '../utils/fs.js';
import { configureWorkspaceProjects, discoverProject } from '../project/detect.js';
import { addRecommendedGitignore, recommendedGitignoreGroups } from '../git/ignore.js';
import { createInitialCommit, initializeRepository } from '../git/repository.js';
import { showChecksStep } from './setup-checks.js';

export function handlesGitBootstrapScreen(screen) {
  return ['setup-git-init', 'setup-gitignore', 'setup-initial-commit', 'initial-commit-message'].includes(screen);
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
      label: 'Add current files and create the first commit',
      description: 'Run git add --all and commit everything not excluded by .gitignore as “Initial commit”.',
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
      instructions: ['Zipflow will add all current files except paths excluded by .gitignore.'],
    }, 'Initial commit');
  }
  if (itemId === 'initial-commit-default') return createFirstCommit(controller, 'Initial commit');
}

async function createFirstCommit(controller, message) {
  const result = await createInitialCommit(controller.state.project.root, message);
  if (!result.ok) {
    controller.message('First commit was not created', [result.reason, 'You can retry, change the message, or skip this step.'], 'error');
    return showInitialCommitStep(controller);
  }
  controller.message('First commit created', [
    `${result.revision} ${message}`,
    `${result.paths.length} files added to the Git baseline.`,
  ], 'success');
  showChecksStep(controller);
}
