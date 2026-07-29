import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { handleInputEditorKey } from 'terlio.js';
import { normalizeZipflowKey } from '../app/key-normalization.js';
import { isPlainEnter } from '../app/editor-enter.js';
import {
  acceptPathSuggestion,
  clearPathSuggestions,
  movePathSuggestion,
  navigatePathSuggestionParent,
  refreshPathSuggestions,
  resetPathSuggestionInput,
} from '../app/path-suggestions.js';
import {
  handleEmptyArchiveEnter,
  selectedDiscoveredArchive,
} from '../app/run-archive-discovery.js';
import { configureI18n } from '../i18n/index.js';
import { rememberArchivePath } from '../settings/recent.js';
import { loadSettings } from '../settings/store.js';
import {
  appendMessage,
  setScreen,
} from '../app/state.js';
import { moveSelectableIndex } from '../app/list-navigation.js';
import { connectStandaloneServer } from './local-server.js';
import {
  actionInputDescriptor,
  appendServerEvent,
  applyProjectHome,
  applySemanticSurface,
} from './surface-state.js';
import {
  saveWorkflowResource,
  showDiffResource,
  showHistoryResource,
  showPlanResource,
  showReportResource,
  showWorkflowResource,
} from './resource-views.js';

export class ClientBackedZipflowController {
  constructor(state, {
    connect = connectStandaloneServer,
    cwd = process.cwd(),
    createId = randomUUID,
    statFile = stat,
    createFileStream = createReadStream,
    settingsLoader = loadSettings,
    i18nConfigurator = configureI18n,
  } = {}) {
    this.state = state;
    this.connect = connect;
    this.cwd = path.resolve(cwd);
    this.createId = createId;
    this.statFile = statFile;
    this.createFileStream = createFileStream;
    this.settingsLoader = settingsLoader;
    this.i18nConfigurator = i18nConfigurator;
    this.runtime = null;
    this.connection = null;
    this.client = null;
    this.project = null;
    this.workflowResource = null;
    this.runId = '';
    this.operationId = '';
    this.eventCursor = 0;
    this.eventAbort = null;
    this.eventTask = null;
    this.pendingInput = null;
    this.cleaned = false;
    state.dispatch = (action) => {
      void this.dispatch(action).catch((error) => this.handleUnexpected(error));
    };
    state.invalidate = () => this.invalidate();
  }

  attachRuntime(runtime) {
    this.runtime = runtime;
    this.state.overlays = runtime?.overlays ?? null;
  }

  async boot() {
    this.state.status = 'Connecting to local workflow service';
    try {
      this.state.settings = await this.settingsLoader();
      this.state.i18n = await this.i18nConfigurator(this.state.settings.interfaceLanguage);
      this.connection = await this.connect();
      this.client = this.connection.client;
      const opened = await this.client.openProject({
        path: this.cwd,
        client: { name: 'zipflow', instanceId: this.createId() },
        idempotencyKey: `zipflow:tui:open:${this.createId()}`,
      });
      this.project = opened;
      this.state.serverHello = structuredClone(this.connection.hello);
      if (opened.activeRunId) {
        this.runId = opened.activeRunId;
        await this.refreshRun();
        await this.subscribeToEvents();
      } else {
        applyProjectHome(this.state, opened);
      }
      this.invalidate();
    } catch (error) {
      await this.handleUnexpected(error);
    }
  }

  handleKey(key) {
    const normalized = normalizeZipflowKey(key);
    if (normalized.name === 'ctrl-c' || (normalized.ctrl && normalized.name === 'c')) {
      return this.handleInterrupt();
    }
    if (['archive', 'action-text'].includes(this.pendingInput?.kind)) {
      return this.handleEditorKey(normalized);
    }
    if (normalized.name === 'up' || normalized.name === 'down') {
      this.moveSelection(normalized.name === 'up' ? -1 : 1);
      this.invalidate();
      return Promise.resolve();
    }
    if (normalized.name === 'enter' || normalized.name === 'space') return this.activateSelected();
    if (normalized.name === 'escape') {
      if (this.state.screen === 'diff-view') return this.showPlan();
      return this.showProject();
    }
    return Promise.resolve();
  }

  async dispatch(action = {}) {
    if (action.type === 'activate-index') {
      this.state.selectedIndex = Math.max(0, Math.trunc(Number(action.index) || 0));
      return this.activateSelected();
    }
    if (action.type === 'menu-move-selection') {
      this.moveSelection(Number(action.delta) || 0, { wrap: action.wrap !== false });
      return this.invalidate();
    }
    if (action.type === 'activity-follow-latest') {
      this.state.transcriptSticky = true;
      this.state.activityUnread = 0;
      return this.invalidate();
    }
  }

  async activateSelected() {
    const item = this.state.menuItems[this.state.selectedIndex];
    if (!item || item.disabled) return;
    if (this.state.screen === 'archive-discovery') {
      const candidate = selectedDiscoveredArchive(this.state, item.id);
      return candidate ? this.startArchive(candidate.path) : this.promptArchive();
    }
    if (item.serverAction) return this.activateAction(item.serverAction);
    if (item.activate === 'save-workflow') return this.saveWorkflow();
    if (item.diffPath) return this.showDiff(item.diffPath);
    if (item.runId) {
      this.runId = item.runId;
      return this.refreshRun();
    }
    switch (item.id) {
      case 'server:exit': return this.exit(0);
      case 'server:home': return this.showProject();
      case 'server:resume-run': return this.openActiveRun();
      case 'server:archive': return this.promptArchive();
      case 'server:checks': return this.startChecks();
      case 'server:workflow': return this.showWorkflow();
      case 'server:history':
      case 'server:view-history': return this.showHistory();
      case 'server:view-plan': return this.showPlan();
      case 'server:view-report': return this.showReport();
      case 'server:confirm-action': {
        const pending = this.pendingInput;
        this.pendingInput = null;
        return pending?.action ? this.activateAction({ ...pending.action, dangerousConfirmed: true }) : undefined;
      }
      case 'server:cancel-action': {
        this.pendingInput = null;
        return this.refreshRun();
      }
      default:
        if (item.serverInputChoice) return this.submitChoice(item.serverInputChoice);
        return undefined;
    }
  }

  async showProject() {
    await this.stopEvents();
    const project = await this.client.getProject(this.project.projectId);
    this.project = project;
    this.runId = project.activeRunId || '';
    applyProjectHome(this.state, project);
    this.invalidate();
  }

  async openActiveRun() {
    this.runId = this.project.activeRunId;
    await this.refreshRun();
    await this.subscribeToEvents();
  }

  async showWorkflow() {
    return showWorkflowResource(this);
  }

  async saveWorkflow() {
    return saveWorkflowResource(this);
  }

  async showHistory() {
    return showHistoryResource(this);
  }

  async showPlan() {
    return showPlanResource(this);
  }

  async showDiff(diffPath, mode = 'unified') {
    return showDiffResource(this, diffPath, mode);
  }

  async showReport() {
    return showReportResource(this);
  }

  promptArchive() {
    this.pendingInput = { kind: 'archive' };
    this.state.archiveDiscoveryTap = null;
    this.state.archiveDiscoveryCandidates = [];
    resetPathSuggestionInput(this.state);
    this.state.editor.setValue?.('');
    this.state.editor.value = '';
    this.state.editor.cursor = 0;
    this.state.editorContext = {
      label: 'ZIP archive',
      placeholder: '/absolute/path/to/update.zip',
      purpose: 'server-archive',
      instructions: ['The archive is streamed into server-owned blob storage.'],
    };
    setScreen(this.state, 'archive-input', {
      status: 'Choose ZIP archive',
      intro: ['Enter an absolute ZIP archive path.'],
    });
    this.invalidate();
  }

  async startArchive(archivePath) {
    const absolute = path.resolve(archivePath);
    const file = await this.statFile(absolute);
    if (!file.isFile()) throw Object.assign(new Error('The selected archive is not a regular file.'), { code: 'ARCHIVE_INPUT_INVALID' });
    await rememberArchivePath(this.state, absolute);
    const uploadKey = `zipflow:tui:blob:${this.createId()}`;
    const blob = await this.client.uploadZip(this.createFileStream(absolute), {
      filename: path.basename(absolute),
      contentLength: file.size,
      idempotencyKey: uploadKey,
    });
    const started = await this.client.startArchiveRun(this.project.projectId, {
      kind: 'archive',
      blobId: blob.blobId,
      seriesId: null,
      correlation: { producer: 'zipflow', requestId: this.createId() },
    }, {
      idempotencyKey: `zipflow:tui:archive:${this.createId()}`,
    });
    const body = started.body ?? started;
    this.runId = body.runId;
    this.operationId = body.operationId;
    this.state.serverBlob = structuredClone(blob);
    await this.refreshRun();
    await this.subscribeToEvents();
  }

  async startChecks() {
    const started = await this.client.startCheckRun(this.project.projectId, {
      seriesId: null,
    }, {
      idempotencyKey: `zipflow:tui:checks:${this.createId()}`,
    });
    const body = started.body ?? started;
    this.runId = body.runId;
    this.operationId = body.operationId;
    await this.refreshRun();
    await this.subscribeToEvents();
  }

  async refreshRun() {
    const [run, surface] = await Promise.all([
      this.client.getRun(this.runId),
      this.client.getSurface(this.runId),
    ]);
    this.state.run = { id: this.runId, status: run.status ?? run.run?.status };
    this.operationId = run.operationId ?? run.operation?.id ?? this.operationId;
    applySemanticSurface(this.state, surface);
    this.invalidate();
    return surface;
  }

  async activateAction(action) {
    if (action.confirmation === 'dangerous' && action.dangerousConfirmed !== true) {
      this.pendingInput = { kind: 'dangerous-confirm', action };
      setScreen(this.state, this.state.screen, {
        status: 'Confirmation required',
        intro: [
          action.label,
          'This action can modify project or external state and requires a second confirmation.',
        ],
        items: [
          {
            id: 'server:confirm-action',
            label: `Confirm ${action.label}`,
            description: action.description,
            serverLocal: true,
          },
          { id: 'server:cancel-action', label: 'Cancel', serverLocal: true },
        ],
      });
      return this.invalidate();
    }
    const descriptor = actionInputDescriptor(this.state.serverSurface, action);
    if (descriptor.kind === 'none') return this.performAction(action, {});
    if (descriptor.kind === 'choice' && descriptor.choices.length === 1) {
      return this.performAction(action, { [descriptor.name]: descriptor.choices[0].id });
    }
    if (descriptor.kind === 'choice') {
      this.pendingInput = { kind: 'action-choice', action, descriptor };
      setScreen(this.state, this.state.screen, {
        status: action.label,
        intro: [action.description],
        items: descriptor.choices.map((choice) => ({
          id: `server:input:${choice.id}`,
          label: choice.label,
          description: choice.description,
          serverInputChoice: choice,
        })),
      });
      return this.invalidate();
    }
    this.pendingInput = { kind: 'action-text', action, descriptor };
    this.state.editor.setValue?.('');
    this.state.editor.value = '';
    this.state.editor.cursor = 0;
    this.state.editorContext = {
      label: action.label,
      placeholder: descriptor.kind === 'json' ? '{"value":"..."}' : '',
      purpose: 'server-action',
      multiline: descriptor.multiline === true || descriptor.kind === 'json',
      instructions: [action.description],
    };
    setScreen(this.state, action.id === 'commit' ? 'commit-message' : 'custom-check-command', {
      status: action.label,
      intro: [action.description],
    });
    this.invalidate();
  }

  submitChoice(choice) {
    const pending = this.pendingInput;
    if (pending?.kind !== 'action-choice') return;
    this.pendingInput = null;
    return this.performAction(pending.action, { [pending.descriptor.name]: choice.id });
  }

  async performAction(action, input) {
    const revision = this.state.serverSurface?.revision;
    const result = await this.client.performAction(this.runId, action.id, input, {
      ifMatch: revision,
      idempotencyKey: `zipflow:tui:action:${this.runId}:${action.id}:${this.createId()}`,
    });
    const body = result.body ?? result;
    if (body?.surface) applySemanticSurface(this.state, body.surface);
    else await this.refreshRun();
    this.operationId = body?.result?.operationId ?? this.operationId;
    await this.subscribeToEvents();
    this.invalidate();
  }

  async subscribeToEvents() {
    await this.stopEvents();
    this.eventAbort = new AbortController();
    const signal = this.eventAbort.signal;
    const stream = this.client.events({
      projectId: this.project.projectId,
      runId: this.runId || undefined,
      lastEventId: this.eventCursor || undefined,
      serverEpoch: this.connection.hello.serverEpoch,
      signal,
    });
    this.eventTask = this.consumeEvents(stream, signal);
  }

  async consumeEvents(stream, signal) {
    try {
      for await (const event of stream) {
        if (signal.aborted) break;
        this.eventCursor = event.sequence;
        appendServerEvent(this.state, event);
        if (event.type === 'stream.gap') {
          this.eventCursor = 0;
          await this.refreshRun();
          break;
        }
        if (['surface.changed', 'run.attention', 'run.completed', 'run.failed', 'run.rolled_back'].includes(event.type)) {
          await this.refreshRun();
        } else this.invalidate();
      }
    } catch (error) {
      if (!signal.aborted) {
        this.state.status = `Connection degraded: ${error.message}`;
        this.invalidate();
      }
    }
  }

  async handleEditorKey(key) {
    if (key.name === 'escape') {
      this.pendingInput = null;
      resetPathSuggestionInput(this.state);
      return this.runId ? this.refreshRun() : this.showProject();
    }
    if (this.pendingInput?.kind === 'archive') {
      if (isPlainEnter(key)
        && !String(this.state.editor.value ?? '').trim()
        && !this.state.pathSuggestions?.items?.length) {
        if (await handleEmptyArchiveEnter(this, {
          returnToInput: () => this.promptArchive(),
        })) return this.invalidate();
      }
      const reverseTab = (key.name === 'tab' && key.shift)
        || key.name === 'backtab'
        || key.name === 'shift-tab';
      if (reverseTab) {
        if (await navigatePathSuggestionParent(this)) this.invalidate();
        return;
      }
      if ((key.name === 'up' || key.name === 'down')
        && this.state.pathSuggestions?.items?.length) {
        movePathSuggestion(this.state, key.name === 'up' ? -1 : 1);
        return this.invalidate();
      }
      if (((key.name === 'tab' && !key.shift) || isPlainEnter(key))
        && this.state.pathSuggestions?.items?.length) {
        await acceptPathSuggestion(this, {
          submit: () => this.startArchive(this.state.editor.value),
          submitSelected: false,
        });
        return this.invalidate();
      }
    }
    if (isPlainEnter(key)) {
      const value = String(this.state.editor.value ?? '').trim();
      const pending = this.pendingInput;
      this.pendingInput = null;
      if (pending?.kind === 'archive') {
        resetPathSuggestionInput(this.state);
        return this.startArchive(value);
      }
      if (pending?.kind === 'action-text') {
        const input = pending.descriptor.kind === 'json'
          ? JSON.parse(value)
          : { [pending.descriptor.name]: value };
        return this.performAction(pending.action, input);
      }
      return;
    }
    const previousValue = this.state.editor.value;
    handleInputEditorKey(this.state.editor, key, {
      multiline: Boolean(this.state.editorContext?.multiline),
    });
    if (this.pendingInput?.kind === 'archive'
      && this.state.editor.value !== previousValue) {
      this.state.pathSuggestionActive = Boolean(String(this.state.editor.value ?? '').trim());
      await refreshPathSuggestions(this);
    }
    this.invalidate();
  }

  setStatus(value) {
    this.state.status = String(value ?? '');
    this.invalidate();
  }

  toast(title, tone = 'info', _seconds = 4, detail = '') {
    appendMessage(this.state, title, detail ? [detail] : [], tone, {
      collapsible: false,
    });
    this.invalidate();
  }

  beginOperation() {
    const abort = new AbortController();
    return {
      signal: abort.signal,
      update() {},
      finish() {},
      cancel: () => abort.abort(),
    };
  }

  showMenu(screen, items, status = null, selectedIndex = 0, intro = []) {
    setScreen(this.state, screen, {
      items,
      status,
      selectedIndex,
      intro,
    });
    this.invalidate();
  }

  moveSelection(delta, { wrap = true } = {}) {
    const items = this.state.menuItems ?? [];
    if (!items.length) return;
    this.state.selectedIndex = moveSelectableIndex(items, this.state.selectedIndex, delta, { wrap });
  }

  async handleInterrupt() {
    if (this.operationId) {
      try {
        await this.client.cancelOperation(this.operationId, {
          idempotencyKey: `zipflow:tui:cancel:${this.operationId}`,
        });
        this.state.status = 'Cancellation requested';
        this.invalidate();
        return;
      } catch (error) {
        if (error.code !== 'OPERATION_NOT_FOUND') throw error;
      }
    }
    this.exit(0);
  }

  async handleUnexpected(error) {
    appendMessage(this.state, 'Workflow error', [
      `${error.code ?? 'ZIPFLOW_ERROR'}: ${error.message}`,
      error.recoveryAction ?? '',
    ].filter(Boolean), 'error', { collapsible: false });
    setScreen(this.state, 'error', {
      status: 'Error',
      intro: ['The local workflow service could not complete the request.'],
      items: [
        ...(this.client ? [{ id: 'server:home', label: 'Back to project', serverLocal: true }] : []),
        { id: 'server:exit', label: 'Exit', serverLocal: true },
      ],
    });
    this.invalidate();
  }

  startStartupUpdateCheck() {
    return Promise.resolve(null);
  }

  requestRestart() {
    this.exit(0);
  }

  invalidate() {
    this.runtime?.invalidate();
  }

  exit(code = 0) {
    this.runtime?.exit(code);
  }

  async stopEvents() {
    this.eventAbort?.abort();
    this.eventAbort = null;
    await this.eventTask?.catch(() => {});
    this.eventTask = null;
  }

  async cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    await this.stopEvents();
    await this.connection?.close();
  }
}
