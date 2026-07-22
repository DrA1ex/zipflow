import path from 'node:path';
import { copyTextToClipboard, handleInputEditorKey } from 'terlio.js';
import { runReportPath } from '../runs/store.js';
import { revealFile } from '../utils/reveal.js';
import { discoverProject } from '../project/detect.js';
import { ensureZipflowHome, getZipflowHome, loadWorkflow } from '../workflow/store.js';
import { loadSettings } from '../settings/store.js';
import { displayPath } from '../utils/paths.js';
import { ZIPFLOW_VERSION } from '../version.js';
import { appendMessage, setScreen } from './state.js';
import {
  activateSetup, backSetup, beginSetup, handleSetupShortcut, handlesSetupScreen, submitSetupEditor,
} from './setup-flow.js';
import {
  activateRun, backRun, beginArchiveInput, handleRunShortcut, handlesRunScreen, inspectArchivePath, showLastRun, submitRunEditor,
} from './run-flow.js';
import {
  closeSettings, handleSettingsKey, isSettingsScreen, openSettings, selectChoice, selectModelSettingChoice,
  selectModelSettingParameter, selectParameter, selectSetting,
} from './settings-panel.js';
import { handleReplayDispatch } from './settings-model-replay.js';
import { projectSummary } from '../ui/format.js';
import { toggleActivityBlockAtRow, toggleActivityBlockAtScroll } from '../ui/activity.js';
import { terminateActiveProcesses } from '../utils/process.js';
import { OperationManager } from '../operations/manager.js';
import { removeIfExists } from '../utils/fs.js';
import { clearRunSettings } from './runtime-settings.js';
import { offerInterruptedRunRecovery } from './interrupted-run.js';
import {
  beginMenuSearch, followLatestActivity, handleMenuSearchKey, showContextHelp,
} from './controller-navigation.js';
import {
  activateExport, backExport, beginCreateZip, handleExportShortcut, handlesExportScreen, submitExportEditor,
} from './export-flow.js';
import { activateHistory, backHistory, handlesHistoryScreen, repeatLastArchive, showRunHistory } from './history-flow.js';
import { activateManual, backManual, beginManualChecks, beginManualDeploy, handlesManualScreen } from './manual-flow.js';
import {
  acceptPathSuggestion, clearPathSuggestions, isPathEditorScreen, movePathSuggestion,
  refreshPathSuggestions, resetPathSuggestionInput, selectPathSuggestion, showRecentArchiveSuggestions,
} from './path-suggestions.js';
import { isEditorScreen, isPagedMenuScreen, isSearchableScreen, shouldRecordChoice } from './controller-screen-rules.js';

export class ZipflowController {
  constructor(state) {
    this.state = state;
    this.runtime = null;
    this.activeLock = null;
    this.operations = new OperationManager({
      onChange: (operation) => { state.activeOperation = operation; this.invalidate(); },
      forceStop: () => terminateActiveProcesses({ graceMs: 0 }),
    });
    state.dispatch = (action) => { void this.dispatch(action).catch((error) => this.handleUnexpected(error)); };
  }

  attachRuntime(runtime) {
    this.runtime = runtime;
    this.state.overlays = runtime?.overlays ?? null;
  }

  async boot() {
    try {
      await ensureZipflowHome();
      this.state.settings = await loadSettings();
      this.state.project = await discoverProject(process.cwd());
      this.state.workflow = await loadWorkflow(this.state.project.root);
      this.message('Project detected', projectSummary(this.state.project, this.state.workflow), 'project');
      if (this.state.workflow) {
        if (await offerInterruptedRunRecovery(this)) return;
        beginArchiveInput(this);
      } else this.showHome();
    } catch (error) {
      this.message('Zipflow could not start', [error.message], 'error');
      this.showMenu('error', [{ id: 'exit', label: 'Exit' }], 'Startup failed');
    }
  }

  async handleKey(key) {
    const normalized = key.printable && key.text === ' ' ? { ...key, name: 'space' } : key;
    if (isInterruptKey(normalized)) return this.handleInterrupt();
    if (this.state.menuSearch?.active) return handleMenuSearchKey(this, normalized);
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
    if (handleRunShortcut(this, normalized)) return this.invalidate();
    if (normalized.name === 'escape' && this.state.exportAbortController) {
      this.state.exportAbortController.abort();
      this.setStatus('Cancelling ZIP preview preparation…');
      return;
    }
    if (normalized.name === 'escape' && this.state.llmAbortController) {
      this.state.llmAbortController.abort();
      if (this.state.llmRuntime) {
        this.state.llmRuntime.cancellationRequested = true;
        this.state.llmRuntime.phase = 'cancelling';
        this.state.llmRuntime.label = 'Cancelling local LLM generation';
      }
      this.setStatus('Cancelling local LLM generation…');
      return;
    }
    if (this.state.busy || ['checks-running', 'deploy-running', 'manual-checks-running', 'manual-deploy-running'].includes(this.state.screen)) return;
    if (normalized.printable && normalized.text?.toLowerCase() === 'g' && this.state.run?.id) {
      const report = runReportPath(this.state.run.id);
      try {
        await revealFile(report);
        return this.toast('Opened run report', 'success');
      } catch (error) {
        return this.toast('Run report is unavailable', 'warning', 3, error.message);
      }
    }
    if (normalized.printable && normalized.text === '?') return showContextHelp(this);
    if ((normalized.name === 'page-up' || normalized.name === 'page-down') && isPagedMenuScreen(this.state.screen)) {
      this.pageSelection(normalized.name === 'page-up' ? -1 : 1);
      return this.invalidate();
    }
    if (normalized.name === 'page-up' || normalized.name === 'page-down') {
      const delta = normalized.name === 'page-up' ? -8 : 8;
      const maxScroll = this.state.activityLayout?.maxScroll ?? Number.MAX_SAFE_INTEGER;
      this.state.transcriptScroll = Math.max(0, Math.min(maxScroll, this.state.transcriptScroll + delta));
      this.state.transcriptSticky = this.state.transcriptScroll >= maxScroll;
      if (this.state.transcriptSticky) this.state.activityUnread = 0;
      return this.invalidate();
    }
    if ((normalized.name === 'home' || normalized.name === 'end') && isPagedMenuScreen(this.state.screen)) {
      this.jumpSelection(normalized.name === 'home' ? 'first' : 'last');
      return this.invalidate();
    }
    if (normalized.name === 'end' && !isEditorScreen(this.state.screen)) {
      followLatestActivity(this);
      return this.invalidate();
    }
    if (normalized.printable && normalized.text === '/' && isSearchableScreen(this.state.screen)) {
      beginMenuSearch(this);
      return this.invalidate();
    }
    if (normalized.printable && normalized.text?.toLowerCase() === 'e' && !isEditorScreen(this.state.screen)) {
      if (toggleActivityBlockAtScroll(this.state)) {
        this.setStatus('Activity block toggled');
        return this.invalidate();
      }
    }
    if (isEditorScreen(this.state.screen)) return this.handleEditorKey(normalized);
    if (handleSetupShortcut(this, normalized) || handleExportShortcut(this, normalized)) return this.invalidate();
    if (normalized.name === 'up' || normalized.name === 'down') {
      this.moveSelection(normalized.name === 'up' ? -1 : 1);
      return this.invalidate();
    }
    if (normalized.name === 'enter' || normalized.name === 'space') return this.activateSelected();
    if (normalized.name === 'escape') return this.back();
  }

  beginOperation(options) {
    return this.operations.begin(options);
  }

  showContextHelp() {
    return showContextHelp(this);
  }

  async handleInterrupt() {
    const result = await this.operations.interrupt();
    if (!result.handled) {
      this.exit(0);
      return;
    }
    const operation = result.operation;
    if (result.waitingForCritical) {
      this.setStatus(`Cancellation requested · finishing ${operation?.phase || operation?.label || 'the current transaction'}…`);
      return;
    }
    if (result.forced) {
      this.setStatus(`Force-stopping ${operation?.label || 'the active operation'}…`);
      return;
    }
    this.setStatus(`Cancelling ${operation?.label || 'the active operation'}…`);
  }

  async dispatch(action) {
    if (action.type === 'activity-follow-latest') {
      followLatestActivity(this);
      this.invalidate();
      return;
    }
    if (action.type === 'activity-toggle-row') {
      if (toggleActivityBlockAtRow(this.state, action.row)) this.invalidate();
      return;
    }
    if (action.type === 'settings-select-setting') return selectSetting(this, action.index);
    if (action.type === 'settings-select-parameter') return selectParameter(this, action.index);
    if (action.type === 'settings-select-choice') return selectChoice(this, action.index);
    if (action.type === 'settings-model-select-parameter') return selectModelSettingParameter(this, action.index);
    if (action.type === 'settings-model-select-choice') return selectModelSettingChoice(this, action.index);
    if (handleReplayDispatch(this, action)) return;
    if (action.type === 'path-select') {
      selectPathSuggestion(this.state, action.index);
      if (this.state.pathSuggestions?.owner === 'settings-modal') {
        await handleSettingsKey(this, { name: 'enter' });
      } else await acceptPathSuggestion(this, { submit: () => this.submitCurrentEditor(), submitSelected: false });
      return;
    }
    if (action.type === 'activate-index') {
      this.state.selectedIndex = action.index;
      await this.activateSelected();
      this.invalidate();
    }
  }

  async activateSelected() {
    const item = this.state.menuItems[this.state.selectedIndex];
    if (!item || item.disabled) return;
    if (shouldRecordChoice(this.state.screen, item.id)) this.recordChoice(item.label);
    if (this.state.screen === 'home' || this.state.screen === 'new-project') return this.activateHome(item.id);
    if (handlesSetupScreen(this.state.screen)) return activateSetup(this, item.id);
    if (handlesRunScreen(this.state.screen)) return activateRun(this, item.id);
    if (handlesExportScreen(this.state.screen)) return activateExport(this, item.id);
    if (handlesHistoryScreen(this.state.screen)) return activateHistory(this, item.id);
    if (handlesManualScreen(this.state.screen)) return activateManual(this, item.id);
    if (this.state.screen === 'error') {
      if (item.id === 'retry-step') return this.retryRecovery();
      if (item.id === 'choose-another-archive') return beginArchiveInput(this);
      if (item.id === 'open-llm-settings') return openSettings(this, { categoryId: 'localLlm' });
      if (item.id === 'continue-without-llm') return this.continueRecoveryWithoutLlm();
      if (item.id === 'copy-diagnostics') {
        const copied = await copyTextToClipboard(this.recoveryText(), { output: this.runtime?.output });
        return copied ? this.toast('Diagnostics copied', 'success') : this.setStatus('Clipboard transfer unavailable');
      }
      if (item.id === 'view-report' && this.state.run) {
        const { showRunDetails } = await import('./run-rollback.js');
        return showRunDetails(this, this.state.run, { origin: 'error' });
      }
      if (item.id === 'back-home') return this.showHome();
      if (item.id === 'exit') return this.exit(1);
    }
  }

  recordChoice(label) {
    appendMessage(this.state, 'Your choice', [label], 'choice');
    if (this.state.run) {
      this.state.run.decisions ??= [];
      this.state.run.decisions.push({ screen: this.state.screen, label, at: new Date().toISOString() });
    }
  }

  showHome() {
    const { project, workflow } = this.state;
    this.state.run = null;
    clearRunSettings(this.state);
    this.state.archive = null;
    this.state.archiveMetadata = null;
    this.state.archiveSafety = null;
    this.state.plan = null;
    this.state.runDetailsOrigin = null;
    if (workflow) {
      const lastRun = workflow.lastRunId ? `Last run: ${workflow.lastRunId}` : 'No previous runs';
      const checks = workflow.checks.filter((check) => check.selected);
      const deployConfigured = Boolean(workflow.deploy?.commandText);
      return this.showMenu('home', [
        { id: 'start-update', label: 'Start an update', description: 'Choose a ZIP archive and use the saved workflow' },
        ...(checks.length ? [{ id: 'run-tests', label: 'Run tests', description: `Run ${checks.length} configured check${checks.length === 1 ? '' : 's'} against the current project` }] : []),
        ...(deployConfigured ? [{ id: 'run-deploy-now', label: 'Run deployment', description: workflow.deploy.commandText }] : []),
        { id: 'change-workflow', label: 'Change workflow', description: 'Review and update the workflow; nothing changes until you confirm the final step' },
        { id: 'create-zip', label: 'Create ZIP', description: 'Export tracked, non-ignored, selected, or all project files' },
        { id: 'repeat-last', label: 'Repeat last archive', description: workflow.lastRunId ? 'Rebuild the previous archive plan against the current project' : 'No previous archive', disabled: !workflow.lastRunId },
        { id: 'run-history', label: 'Run history', description: lastRun },
        { id: 'exit', label: 'Exit' },
      ], 'Ready');
    }
    return this.showMenu('new-project', [
      { id: 'setup-project', label: 'Set up this project', description: `${displayPath(project.root)} · ${project.labels.join(' · ') || 'Custom project'}` },
      { id: 'choose-directory', label: 'Choose another directory', description: 'Tab completes directory names' },
      { id: 'create-zip', label: 'Create ZIP', description: 'Export files before configuring an update workflow' },
      { id: 'exit', label: 'Exit' },
    ], 'Workflow not configured', 0, [
      'Zipflow found the current project but no saved workflow.',
      'Setup will detect useful checks, choose safe update defaults, and show every selected parameter before saving.',
    ]);
  }

  showMenu(screen, items, status = null, selectedIndex = null, intro = []) {
    clearPathSuggestions(this.state);
    let nextIndex = selectedIndex;
    if (nextIndex === null && this.state.screen === screen) {
      const previousId = this.state.menuItems[this.state.selectedIndex]?.id;
      const matchingIndex = items.findIndex((item) => item.id === previousId);
      nextIndex = matchingIndex >= 0 ? matchingIndex : this.state.selectedIndex;
    }
    setScreen(this.state, screen, { items, selectedIndex: nextIndex ?? 0, status, intro });
    this.state.busy = false;
    this.invalidate();
  }

  showEditor(screen, context, value = '') {
    resetPathSuggestionInput(this.state);
    this.state.editor.set(String(value ?? ''));
    this.state.editorContext = context;
    setScreen(this.state, screen, { items: [], status: context.label });
    this.invalidate();
    if (!isPathEditorScreen(screen)) clearPathSuggestions(this.state);
  }

  message(title, lines = [], tone = 'info', options = {}) {
    appendMessage(this.state, title, lines, tone, options);
    this.invalidate();
  }

  toast(message, level = 'info', ttl = 3, detail = '') {
    this.state.overlays?.toast?.(String(message ?? ''), level, ttl, String(detail ?? ''));
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
    this.recovery = { error, kind: 'unexpected' };
    this.message('Unexpected error', [error.message], 'error', { collapsedSummary: `Unexpected error · ${error.message}` });
    this.showMenu('error', [
      { id: 'copy-diagnostics', label: 'Copy diagnostics', description: 'Copy the error, current screen, project, and run information' },
      ...(this.state.run ? [{ id: 'view-report', label: 'View run report', description: `Open stored details for ${this.state.run.id}` }] : []),
      { id: 'back-home', label: 'Return to project', description: 'Return to the project without retrying the failed action' },
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
    if (itemId === 'change-workflow' || itemId === 'review-settings') return beginSetup(this, { fresh: false });
    if (itemId === 'last-run') return showLastRun(this);
    if (itemId === 'run-history') return showRunHistory(this);
    if (itemId === 'repeat-last') return repeatLastArchive(this);
    if (itemId === 'create-zip') return beginCreateZip(this);
    if (itemId === 'run-tests') return beginManualChecks(this);
    if (itemId === 'run-deploy-now') return beginManualDeploy(this);
    if (itemId === 'setup-project') return beginSetup(this, { fresh: true });
    if (itemId === 'choose-directory') {
      await beginSetup(this, { fresh: true });
      return this.showEditor('project-path-input', {
        label: 'Project directory', placeholder: this.state.project.root, purpose: 'setup-project-path',
        instructions: ['Enter the project directory. Tab completes directory names.'],
      }, this.state.project.root);
    }
  }

  async inspectArchivePath(archivePath, options = {}) {
    return inspectArchivePath(this, archivePath, options);
  }

  recoveryText() {
    const error = this.recovery?.error;
    return [
      `Zipflow ${ZIPFLOW_VERSION ?? ''}`.trim(),
      `Screen: ${this.state.screen}`,
      `Project: ${this.state.project?.root ?? 'unknown'}`,
      `Run: ${this.state.run?.id ?? 'none'}`,
      `Status: ${this.state.run?.status ?? this.state.status ?? 'unknown'}`,
      `Error: ${error?.message ?? 'unknown'}`,
      error?.stack ? `\n${error.stack}` : '',
    ].filter(Boolean).join('\n');
  }

  async retryRecovery() {
    const retry = this.recovery?.retry;
    if (typeof retry !== 'function') return this.showHome();
    return retry();
  }

  async continueRecoveryWithoutLlm() {
    const action = this.recovery?.continueWithoutLlm;
    if (typeof action !== 'function') return this.showHome();
    return action();
  }

  async handleEditorKey(key) {
    if (key.name === 'escape') return this.back();
    const pathEditor = isPathEditorScreen(this.state.screen);
    if (this.state.screen === 'archive-input' && key.name === 'tab' && !String(this.state.editor.value ?? '').trim()) {
      if (await showRecentArchiveSuggestions(this)) return this.invalidate();
    }
    if (pathEditor && (key.name === 'up' || key.name === 'down') && this.state.pathSuggestions?.items?.length) {
      movePathSuggestion(this.state, key.name === 'up' ? -1 : 1);
      return this.invalidate();
    }
    if (pathEditor && (key.name === 'tab' || key.name === 'enter') && this.state.pathSuggestions?.items?.length) {
      await acceptPathSuggestion(this, { submit: () => this.submitCurrentEditor(), submitSelected: false });
      return this.invalidate();
    }
    if (key.name === 'enter' && key.ctrl && this.state.editorContext?.multiline) {
      handleInputEditorKey(this.state.editor, key, { multiline: true });
      return this.invalidate();
    }
    if (key.name === 'enter') {
      await this.submitCurrentEditor();
      return this.invalidate();
    }
    const previousValue = this.state.editor.value;
    handleInputEditorKey(this.state.editor, key, { multiline: Boolean(this.state.editorContext?.multiline) });
    if (pathEditor && this.state.editor.value !== previousValue) {
      this.state.pathSuggestionActive = Boolean(String(this.state.editor.value ?? '').trim());
      await refreshPathSuggestions(this);
    }
    this.invalidate();
  }

  async submitCurrentEditor() {
    if (handlesSetupScreen(this.state.screen)) return submitSetupEditor(this);
    if (handlesRunScreen(this.state.screen)) return submitRunEditor(this);
    if (handlesExportScreen(this.state.screen)) return submitExportEditor(this);
    return false;
  }

  async back() {
    if (handlesSetupScreen(this.state.screen)) return backSetup(this);
    if (handlesRunScreen(this.state.screen)) return backRun(this);
    if (handlesExportScreen(this.state.screen)) return backExport(this);
    if (handlesHistoryScreen(this.state.screen)) return backHistory(this);
    if (handlesManualScreen(this.state.screen)) return backManual(this);
    if (this.state.screen === 'home' || this.state.screen === 'new-project') {
      this.setStatus('Use Exit or Ctrl+C to close Zipflow.');
      return false;
    }
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

  jumpSelection(target) {
    const items = this.state.menuItems ?? [];
    if (!items.length) return;
    const indexes = target === 'last' ? [...items.keys()].reverse() : [...items.keys()];
    const next = indexes.find((index) => !items[index]?.disabled);
    if (next !== undefined) this.state.selectedIndex = next;
  }

  pageSelection(direction) {
    const items = this.state.menuItems;
    if (!items.length) return;
    const page = Math.max(5, Math.min(12, Number(this.state.menuPageSize) || 8));
    let next = Math.max(0, Math.min(items.length - 1, this.state.selectedIndex + direction * page));
    const step = direction < 0 ? -1 : 1;
    while (items[next]?.disabled && next >= 0 && next < items.length - 1) next += step;
    if (!items[next]?.disabled) this.state.selectedIndex = next;
  }
}

function isInterruptKey(key) {
  return key?.name === 'ctrl-c' || (key?.ctrl && key?.name === 'c') || key?.name === 'zipflow-interrupt' || key?.name === 'ctrl-z';
}
