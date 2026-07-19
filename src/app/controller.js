import path from 'node:path';
import { handleInputEditorKey } from 'terlio.js';
import { discoverProject } from '../project/detect.js';
import { ensureZipflowHome, getZipflowHome, loadWorkflow } from '../workflow/store.js';
import { loadSettings } from '../settings/store.js';
import { completePath, displayPath } from '../utils/paths.js';
import { appendMessage, setScreen } from './state.js';
import {
  activateSetup, backSetup, beginSetup, handleSetupShortcut, handlesSetupScreen, submitSetupEditor,
} from './setup-flow.js';
import {
  activateRun, backRun, beginArchiveInput, handleConflictShortcut, handlesRunScreen, showLastRun, submitRunEditor,
} from './run-flow.js';
import {
  closeSettings, handleSettingsKey, isSettingsScreen, openSettings, selectOption, selectSetting,
} from './settings-panel.js';
import { projectSummary } from '../ui/format.js';
import { terminateActiveProcesses } from '../utils/process.js';
import { removeIfExists } from '../utils/fs.js';
import {
  activateExport, backExport, beginCreateZip, handleExportShortcut, handlesExportScreen, submitExportEditor,
} from './export-flow.js';

export class ZipflowController {
  constructor(state) {
    this.state = state;
    this.runtime = null;
    this.activeLock = null;
    state.dispatch = (action) => { void this.dispatch(action).catch((error) => this.handleUnexpected(error)); };
  }

  attachRuntime(runtime) {
    this.runtime = runtime;
  }

  async boot() {
    try {
      await ensureZipflowHome();
      this.state.settings = await loadSettings();
      this.state.project = await discoverProject(process.cwd());
      this.state.workflow = await loadWorkflow(this.state.project.root);
      this.message('Project detected', projectSummary(this.state.project, this.state.workflow), this.state.workflow ? 'success' : 'info');
      this.showHome();
    } catch (error) {
      this.message('Zipflow could not start', [error.message], 'error');
      this.showMenu('error', [{ id: 'exit', label: 'Exit' }], 'Startup failed');
    }
  }

  async handleKey(key) {
    const normalized = key.printable && key.text === ' ' ? { ...key, name: 'space' } : key;
    if (normalized.ctrl && normalized.name === 't') {
      const pointerEnabled = this.runtime?.togglePointerOverride?.();
      this.setStatus(pointerEnabled === false
        ? 'Native text selection enabled · drag anywhere · Ctrl+T restores interactive controls'
        : 'Interactive pointer controls restored');
      return;
    }
    if (normalized.ctrl && normalized.name === 'b') {
      if (isSettingsScreen(this.state.screen)) closeSettings(this);
      else await openSettings(this);
      return;
    }
    if (isSettingsScreen(this.state.screen)) return handleSettingsKey(this, normalized);
    if (this.state.busy || ['checks-running', 'deploy-running'].includes(this.state.screen)) return;
    if (normalized.name === 'page-up' || normalized.name === 'page-down') {
      const delta = normalized.name === 'page-up' ? -8 : 8;
      this.state.transcriptScroll = Math.max(0, this.state.transcriptScroll + delta);
      this.state.transcriptSticky = normalized.name === 'page-down';
      return this.invalidate();
    }
    if (isEditorScreen(this.state.screen)) return this.handleEditorKey(normalized);
    if (handleSetupShortcut(this, normalized) || handleConflictShortcut(this, normalized) || handleExportShortcut(this, normalized)) return this.invalidate();
    if (normalized.name === 'up' || normalized.name === 'down') {
      this.moveSelection(normalized.name === 'up' ? -1 : 1);
      return this.invalidate();
    }
    if (normalized.name === 'enter' || normalized.name === 'space') return this.activateSelected();
    if (normalized.name === 'escape') return this.back();
  }

  async dispatch(action) {
    if (action.type === 'settings-select-setting') return selectSetting(this, action.index);
    if (action.type === 'settings-select-option') return selectOption(this, action.index);
    if (action.type === 'activate-index') {
      this.state.selectedIndex = action.index;
      await this.activateSelected();
      this.invalidate();
    }
  }

  async activateSelected() {
    const item = this.state.menuItems[this.state.selectedIndex];
    if (!item || item.disabled) return;
    if (this.state.screen === 'home' || this.state.screen === 'new-project') return this.activateHome(item.id);
    if (handlesSetupScreen(this.state.screen)) return activateSetup(this, item.id);
    if (handlesRunScreen(this.state.screen)) return activateRun(this, item.id);
    if (handlesExportScreen(this.state.screen)) return activateExport(this, item.id);
    if (this.state.screen === 'error') {
      if (item.id === 'back-home') return this.showHome();
      if (item.id === 'exit') return this.exit(1);
    }
  }

  showHome() {
    const { project, workflow } = this.state;
    this.state.run = null;
    this.state.archive = null;
    this.state.archiveMetadata = null;
    this.state.plan = null;
    if (workflow) {
      return this.showMenu('home', [
        { id: 'start-update', label: 'Start an update', description: 'Choose a ZIP archive and apply the saved workflow' },
        { id: 'review-settings', label: 'Review workflow', description: `${workflow.checks.filter((check) => check.selected).length} checks · ${workflow.policy.label}` },
        { id: 'fresh-setup', label: 'Start setup again', description: 'The current workflow stays active until its replacement is saved' },
        { id: 'create-zip', label: 'Create ZIP', description: 'Export tracked, non-ignored, selected, or all project files' },
        { id: 'last-run', label: 'View last run', description: workflow.lastRunId ?? 'No previous run', disabled: !workflow.lastRunId },
        { id: 'exit', label: 'Exit' },
      ], 'Ready');
    }
    return this.showMenu('new-project', [
      { id: 'setup-project', label: 'Set up this project', description: `${displayPath(project.root)} · ${project.labels.join(' · ') || 'Custom project'}` },
      { id: 'choose-directory', label: 'Choose another directory', description: 'Tab completes directory names' },
      { id: 'create-zip', label: 'Create ZIP', description: 'Export files before configuring an update workflow' },
      { id: 'exit', label: 'Exit' },
    ], 'Workflow not configured');
  }

  showMenu(screen, items, status = null, selectedIndex = null) {
    let nextIndex = selectedIndex;
    if (nextIndex === null && this.state.screen === screen) {
      const previousId = this.state.menuItems[this.state.selectedIndex]?.id;
      const matchingIndex = items.findIndex((item) => item.id === previousId);
      nextIndex = matchingIndex >= 0 ? matchingIndex : this.state.selectedIndex;
    }
    setScreen(this.state, screen, { items, selectedIndex: nextIndex ?? 0, status });
    this.state.busy = false;
    this.invalidate();
  }

  showEditor(screen, context, value = '') {
    this.state.editor.set(String(value ?? ''));
    this.state.editorContext = context;
    setScreen(this.state, screen, { items: [], status: context.label });
    this.invalidate();
  }

  message(title, lines = [], tone = 'info') {
    appendMessage(this.state, title, lines, tone);
    this.invalidate();
  }

  setStatus(status) {
    this.state.status = status;
    this.invalidate();
  }

  invalidate() {
    this.runtime?.invalidate();
  }

  exit(code = 0) {
    this.runtime?.exit(code);
  }

  async handleUnexpected(error) {
    this.state.busy = false;
    await this.activeLock?.release?.().catch(() => {});
    this.activeLock = null;
    this.message('Unexpected error', [error.message], 'error');
    this.showMenu('error', [
      { id: 'back-home', label: 'Return to project' },
      { id: 'exit', label: 'Exit' },
    ], 'Error');
  }

  async cleanup() {
    await terminateActiveProcesses();
    await this.activeLock?.release?.().catch(() => {});
    this.activeLock = null;
    if (this.state.run?.id) await removeIfExists(path.join(getZipflowHome(), 'tmp', this.state.run.id)).catch(() => {});
  }

  async activateHome(itemId) {
    if (itemId === 'exit') return this.exit(0);
    if (itemId === 'start-update') return beginArchiveInput(this);
    if (itemId === 'review-settings') return beginSetup(this, { fresh: false });
    if (itemId === 'fresh-setup') return beginSetup(this, { fresh: true });
    if (itemId === 'last-run') return showLastRun(this);
    if (itemId === 'create-zip') return beginCreateZip(this);
    if (itemId === 'setup-project') return beginSetup(this, { fresh: true });
    if (itemId === 'choose-directory') {
      await beginSetup(this, { fresh: true });
      return this.showEditor('project-path-input', {
        label: 'Project directory', placeholder: this.state.project.root, purpose: 'setup-project-path',
        instructions: ['Enter the project directory. Tab completes directory names.'],
      }, this.state.project.root);
    }
  }

  async handleEditorKey(key) {
    if (key.name === 'escape') return this.back();
    const pathEditor = ['project-path-input', 'archive-input'].includes(this.state.screen);
    if (key.name === 'tab' && pathEditor) {
      const completion = await completePath(this.state.editor.value, {
        cwd: this.state.project?.root ?? process.cwd(),
        directoriesOnly: this.state.screen === 'project-path-input',
        extension: this.state.screen === 'archive-input' ? '.zip' : null,
      });
      if (completion.matches.length) {
        this.state.editor.set(completion.value);
        this.setStatus(completion.matches.length === 1 ? 'Path completed' : `${completion.matches.length} matches`);
      } else this.setStatus('No path matches');
      return;
    }
    if (key.name === 'enter' && key.ctrl && this.state.editorContext?.multiline) {
      handleInputEditorKey(this.state.editor, key, { multiline: true });
      return this.invalidate();
    }
    if (key.name === 'enter') {
      if (handlesSetupScreen(this.state.screen)) await submitSetupEditor(this);
      else if (handlesRunScreen(this.state.screen)) await submitRunEditor(this);
      else if (handlesExportScreen(this.state.screen)) await submitExportEditor(this);
      return this.invalidate();
    }
    handleInputEditorKey(this.state.editor, key, { multiline: Boolean(this.state.editorContext?.multiline) });
    this.invalidate();
  }

  async back() {
    if (handlesSetupScreen(this.state.screen)) return backSetup(this);
    if (handlesRunScreen(this.state.screen)) return backRun(this);
    if (handlesExportScreen(this.state.screen)) return backExport(this);
    if (this.state.screen === 'home' || this.state.screen === 'new-project') return this.exit(0);
    return this.showHome();
  }

  moveSelection(delta) {
    const items = this.state.menuItems;
    if (!items.length) return;
    let next = this.state.selectedIndex;
    for (let attempts = 0; attempts < items.length; attempts += 1) {
      next = (next + delta + items.length) % items.length;
      if (!items[next].disabled) break;
    }
    this.state.selectedIndex = next;
  }
}

function isEditorScreen(screen) {
  return [
    'project-path-input', 'archive-input', 'custom-check-command', 'custom-check-name',
    'commit-message', 'commit-template', 'deploy-command', 'export-path', 'initial-commit-message',
  ].includes(screen);
}
