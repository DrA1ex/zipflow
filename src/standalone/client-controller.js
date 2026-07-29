import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { handleInputEditorKey } from 'terlio.js';
import { isPlainEnter } from '../app/editor-enter.js';
import { ZipflowController } from '../app/controller.js';
import {
  activateSetup,
  backSetup,
  beginSetup,
  handlesSetupScreen,
} from '../app/setup-flow.js';
import {
  activateExport,
  backExport,
  beginCreateZip,
  handlesExportScreen,
} from '../app/export-flow.js';
import {
  activateHistory,
  backHistory,
  handlesHistoryScreen,
  showRunHistory,
} from '../app/history-flow.js';
import {
  acceptPathSuggestion,
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
import { configureWorkspaceProjects, discoverProject } from '../project/detect.js';
import { expandHome } from '../utils/paths.js';
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
  applyServerRunAdvisory,
  applySemanticSurface,
} from './surface-state.js';
import {
  saveWorkflowResource,
  showDiffResource,
  showPlanResource,
  showReportResource,
  showWorkflowResource,
} from './resource-views.js';
import {
  dispatchClientAction,
  handleClientKey,
} from './client-controller-ux.js';
import { finalizeClientSourceArchive } from './client-archive-disposition.js';
import {
  activateClientReview,
  applyClientReviewSurface,
  backClientReview,
  handlesReviewScreen,
  loadClientPlanDiff,
  showClientPlan,
} from './client-review-flow.js';
import {
  copyClientFailedCheckReport,
  showClientFailedCheckOutput,
} from './client-failure-report.js';
import {
  activateClientCommit,
  applyClientCommitSurface,
} from './client-commit-flow.js';
import {
  activateClientHistoryDetail,
  backClientHistoryDetail,
  listClientHistoryRuns,
  loadClientHistoryRun,
} from './client-history.js';

export class ClientBackedZipflowController extends ZipflowController {
  constructor(state, {
    connect = connectStandaloneServer,
    cwd = process.cwd(),
    createId = randomUUID,
    statFile = stat,
    createFileStream = createReadStream,
    settingsLoader = loadSettings,
    i18nConfigurator = configureI18n,
    rememberArchive = rememberArchivePath,
    projectInspector = discoverProject,
    workspaceConfigurator = configureWorkspaceProjects,
    uiControllerOptions = {},
  } = {}) {
    super(state, uiControllerOptions);
    this.state = state;
    this.connect = connect;
    this.cwd = path.resolve(cwd);
    this.createId = createId;
    this.statFile = statFile;
    this.createFileStream = createFileStream;
    this.settingsLoader = settingsLoader;
    this.i18nConfigurator = i18nConfigurator;
    this.rememberArchive = rememberArchive;
    this.projectInspector = projectInspector;
    this.workspaceConfigurator = workspaceConfigurator;
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
    this.sourceArchives = new Map();
    this.archiveDispositionTasks = new Map();
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
      await this.refreshWorkflowResource();
      await this.refreshProjectDetails();
      await this.refreshHomeHistory();
      this.state.serverHello = structuredClone(this.connection.hello);
      if (opened.activeRunId) {
        this.runId = opened.activeRunId;
        await this.refreshRun();
        await this.subscribeToEvents();
      } else {
        applyProjectHome(this.state, opened);
        if (opened.workflowConfigured) this.promptArchive();
      }
      this.invalidate();
    } catch (error) {
      await this.handleUnexpected(error);
    }
  }

  handleKey(key) {
    return handleClientKey(this, key);
  }

  dispatch(action = {}) {
    return dispatchClientAction(this, action);
  }

  async activateSelected() {
    const item = this.state.menuItems[this.state.selectedIndex];
    if (!item || item.disabled) return;
    if (handlesSetupScreen(this.state.screen)) return activateSetup(this, item.id);
    if (handlesExportScreen(this.state.screen)) return activateExport(this, item.id);
    if (handlesHistoryScreen(this.state.screen)) return activateHistory(this, item.id);
    if (item.id === 'server:confirm-action') {
      const pending = this.pendingInput;
      this.pendingInput = null;
      return pending?.action
        ? this.activateAction({ ...pending.action, dangerousConfirmed: true })
        : undefined;
    }
    if (item.id === 'server:cancel-action') {
      this.pendingInput = null;
      return this.refreshRun();
    }
    if (this.state.screen === 'commit') {
      const handled = await activateClientCommit(this, item);
      if (handled !== false) return handled;
    }
    if (handlesReviewScreen(this.state.screen)) {
      const handled = await activateClientReview(this, item.id);
      if (handled !== false) return handled;
    }
    if (['run-details', 'run-file-groups', 'run-file-list', 'run-decisions']
      .includes(this.state.screen)) {
      const handled = await activateClientHistoryDetail(this, item);
      if (handled !== false) return handled;
    }
    if (this.state.screen === 'run-details') {
      if (item.id === 'rollback') {
        const action = this.state.run.serverSurface?.actions?.find(({ id }) => id === 'rollback');
        return action ? this.activateAction(action) : this.showHistory();
      }
      if (item.id === 'another-archive') return this.promptArchive();
      if (item.id === 'back-home') {
        return this.state.runDetailsOrigin === 'history' ? this.showHistory() : this.showProject();
      }
    }
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
      case 'server:deploy': return this.startDeploy();
      case 'server:checks-again': return this.startChecks();
      case 'server:deploy-again': return this.startDeploy();
      case 'server:workflow': return this.beginWorkflowSetup();
      case 'server:create-zip': return beginCreateZip(this);
      case 'server:repeat-last': return this.repeatLastArchive();
      case 'server:duplicate-continue': {
        const pending = this.pendingServerArchive;
        this.pendingServerArchive = null;
        return pending ? this.startUploadedArchive(pending.blob, pending.path) : this.promptArchive();
      }
      case 'server:duplicate-cancel':
        this.pendingServerArchive = null;
        return this.promptArchive();
      case 'server:choose-directory': return this.promptProjectPath();
      case 'server:history':
      case 'server:view-history': return this.showHistory();
      case 'server:view-plan': return this.showPlan();
      case 'server:view-report': return this.showReport();
      case 'server:view-failure': return this.showFailedCheckOutput();
      case 'server:copy-failure': return this.copyFailedCheckReport();
      default:
        if (item.serverInputChoice) return this.submitChoice(item.serverInputChoice);
        return undefined;
    }
  }

  async showProject() {
    await this.stopEvents();
    const project = await this.client.getProject(this.project.projectId);
    this.project = project;
    await this.refreshWorkflowResource();
    await this.refreshProjectDetails();
    await this.refreshHomeHistory();
    this.runId = project.activeRunId || '';
    applyProjectHome(this.state, project);
    this.invalidate();
  }

  async refreshWorkflowResource() {
    const resource = await this.client.getWorkflow(this.project.projectId);
    this.workflowResource = resource;
    this.state.workflow = resource.workflow ? structuredClone(resource.workflow) : null;
    return resource;
  }

  async refreshProjectDetails() {
    const discovered = await this.projectInspector(this.project.canonicalPath).catch(() => null);
    if (!discovered) return null;
    this.state.project = this.state.workflow?.projects?.length
      ? await this.workspaceConfigurator(discovered, this.state.workflow.projects)
      : discovered;
    return this.state.project;
  }

  async refreshHomeHistory() {
    const history = await this.client.getHistory(this.project.projectId, { limit: 100 });
    const items = history.items ?? history.runs ?? [];
    this.archiveHistory = items.filter((run) => run.kind === 'archive' || run.kind == null);
    this.lastArchiveRun = items.find((run) => (
      (run.kind === 'archive' || run.kind == null) && run.blob?.blobId
    )) ?? null;
    this.project.lastArchiveRun = this.lastArchiveRun
      ? structuredClone(this.lastArchiveRun)
      : null;
    return history;
  }

  async beginWorkflowSetup() {
    await this.refreshWorkflowResource();
    return beginSetup(this, { fresh: !this.state.workflow });
  }

  async persistWorkflowDraft(draft) {
    const resource = this.workflowResource ?? await this.refreshWorkflowResource();
    const saved = await this.client.putWorkflow(this.project.projectId, draft, {
      ifMatch: resource.revision,
      idempotencyKey: `zipflow:tui:workflow:${this.project.projectId}:${resource.revision}:${this.createId()}`,
    });
    const body = saved.body ?? saved;
    this.workflowResource = {
      ...resource,
      ...body,
      workflow: structuredClone(body.workflow ?? draft),
      suggestedWorkflow: null,
    };
    this.state.workflow = structuredClone(this.workflowResource.workflow);
    return this.state.workflow;
  }

  async initializeProjectRepository() {
    return this.performProjectSetupAction('initialize-git', {});
  }

  async createRecommendedGitignore() {
    return this.performProjectSetupAction('create-gitignore', {});
  }

  async prepareProjectInitialCommit() {
    return this.performProjectSetupAction('prepare-initial-commit', {});
  }

  async createProjectInitialCommit(message, paths) {
    return this.performProjectSetupAction('create-initial-commit', { message, paths });
  }

  async performProjectSetupAction(actionId, input) {
    const response = await this.client.performProjectSetupAction(
      this.project.projectId,
      actionId,
      input,
      {
        idempotencyKey: `zipflow:tui:project-setup:${actionId}:${this.createId()}`,
      },
    );
    return response.body ?? response;
  }

  afterWorkflowSaved() {
    this.state.draft = null;
    this.state.setupProjectSnapshot = null;
    return this.promptArchive();
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
    return showRunHistory(this);
  }

  async listHistoryRuns({ limit = 40 } = {}) {
    return listClientHistoryRuns(this, { limit });
  }

  async loadHistoryRun(runId) {
    return loadClientHistoryRun(this, runId);
  }

  async showPlan() {
    if (this.runId) return showClientPlan(this);
    return showPlanResource(this);
  }

  async showDiff(diffPath, mode = 'unified') {
    return showDiffResource(this, diffPath, mode);
  }

  async showReport() {
    return showReportResource(this);
  }

  async showFailedCheckOutput() {
    return showClientFailedCheckOutput(this);
  }

  async copyFailedCheckReport() {
    return copyClientFailedCheckReport(this);
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

  promptProjectPath() {
    this.pendingInput = { kind: 'project-path' };
    resetPathSuggestionInput(this.state);
    this.state.editor.set(this.project?.canonicalPath ?? this.cwd);
    this.state.editorContext = {
      label: 'Project directory',
      placeholder: this.project?.canonicalPath ?? this.cwd,
      purpose: 'server-project-path',
      instructions: ['Enter the project directory. Tab completes directory names.'],
    };
    setScreen(this.state, 'project-path-input', {
      status: 'Project directory',
      intro: ['Choose a directory to open through the local workflow service.'],
    });
    this.invalidate();
  }

  async openProjectPath(projectPath) {
    const expanded = expandHome(String(projectPath ?? '').trim());
    const absolute = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(this.project?.canonicalPath ?? this.cwd, expanded);
    await this.stopEvents();
    const opened = await this.client.openProject({
      path: absolute,
      client: { name: 'zipflow', instanceId: this.createId() },
      idempotencyKey: `zipflow:tui:open:${this.createId()}`,
    });
    this.project = opened;
    this.runId = opened.activeRunId || '';
    this.operationId = '';
    await this.refreshWorkflowResource();
    await this.refreshProjectDetails();
    await this.refreshHomeHistory();
    if (opened.activeRunId) {
      await this.refreshRun();
      await this.subscribeToEvents();
    } else {
      applyProjectHome(this.state, opened);
      if (opened.workflowConfigured) this.promptArchive();
    }
    this.invalidate();
  }

  async startArchive(archivePath) {
    const absolute = path.resolve(archivePath);
    const file = await this.statFile(absolute);
    if (!file.isFile()) throw Object.assign(new Error('The selected archive is not a regular file.'), { code: 'ARCHIVE_INPUT_INVALID' });
    await this.rememberArchive(this.state, absolute);
    const uploadKey = `zipflow:tui:blob:${this.createId()}`;
    const blob = await this.client.uploadZip(this.createFileStream(absolute), {
      filename: path.basename(absolute),
      contentLength: file.size,
      idempotencyKey: uploadKey,
    });
    const duplicate = this.archiveHistory?.find((run) => (
      run.blob?.sha256 === blob.sha256
      && ['completed', 'rolled_back'].includes(run.status)
    ));
    if (duplicate && (this.state.workflow?.autonomy?.mode ?? 'manual') === 'manual') {
      this.pendingServerArchive = { path: absolute, blob: structuredClone(blob) };
      setScreen(this.state, 'archive-duplicate', {
        status: 'Archive already applied',
        intro: [
          `${path.basename(absolute)} matches completed run ${duplicate.runId}.`,
          'You can inspect and apply it again against the current project state.',
        ],
        items: [
          {
            id: 'server:duplicate-continue',
            label: 'Inspect and apply again',
            description: 'Build a fresh server-owned plan from this archive.',
            serverLocal: true,
          },
          {
            id: 'server:duplicate-cancel',
            label: 'Choose another archive',
            serverLocal: true,
          },
        ],
      });
      this.invalidate();
      return;
    }
    return this.startUploadedArchive(blob, absolute);
  }

  async startUploadedArchive(blob, absolute) {
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
    this.sourceArchives.set(this.runId, {
      path: absolute,
      hash: blob.sha256,
    });
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

  async startDeploy() {
    const started = await this.client.startDeployRun(this.project.projectId, {
      seriesId: null,
    }, {
      idempotencyKey: `zipflow:tui:deploy:${this.createId()}`,
    });
    const body = started.body ?? started;
    this.runId = body.runId;
    this.operationId = body.operationId;
    await this.refreshRun();
    await this.subscribeToEvents();
  }

  async repeatLastArchive() {
    const previous = this.lastArchiveRun;
    if (!previous?.blob?.blobId) {
      this.toast(
        'No previous archive',
        'warning',
        4,
        'This project has no retained server archive to repeat.',
      );
      return;
    }
    const started = await this.client.startArchiveRun(this.project.projectId, {
      kind: 'archive',
      blobId: previous.blob.blobId,
      seriesId: previous.seriesId ?? previous.runId ?? null,
      correlation: { producer: 'zipflow', requestId: this.createId() },
    }, {
      idempotencyKey: `zipflow:tui:repeat:${previous.runId}:${this.createId()}`,
    });
    const body = started.body ?? started;
    this.runId = body.runId;
    this.operationId = body.operationId;
    await this.refreshRun();
    await this.subscribeToEvents();
  }

  async refreshRun() {
    const [run, surface, report] = await Promise.all([
      this.client.getRun(this.runId),
      this.client.getSurface(this.runId),
      this.client.getReport(this.runId).catch(() => null),
    ]);
    this.state.run = {
      ...structuredClone(run),
      id: run.runId ?? run.run?.runId ?? this.runId,
      status: run.status ?? run.run?.status,
    };
    this.operationId = run.operationId !== undefined
      ? run.operationId || ''
      : run.operation?.id ?? this.operationId;
    applySemanticSurface(this.state, surface);
    applyServerRunAdvisory(this.state, run, report);
    const interactiveReview = await applyClientReviewSurface(this, run, surface, report);
    if (!interactiveReview) applyClientCommitSurface(this, surface);
    await this.finalizeSourceArchiveForRun(run);
    this.invalidate();
    return surface;
  }

  async finalizeSourceArchiveForRun(run) {
    if (run?.status !== 'completed') return null;
    const source = this.sourceArchives.get(this.runId);
    if (!source) return null;
    if (this.archiveDispositionTasks.has(this.runId)) {
      return this.archiveDispositionTasks.get(this.runId);
    }
    this.sourceArchives.delete(this.runId);
    const task = finalizeClientSourceArchive(this, this.runId, source)
      .finally(() => this.archiveDispositionTasks.delete(this.runId));
    this.archiveDispositionTasks.set(this.runId, task);
    return task;
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
    const initialValue = action.id === 'commit'
      ? this.state.serverSurface?.sections
        ?.find(({ kind }) => kind === 'commit')
        ?.suggestedMessage ?? ''
      : '';
    this.state.editor.setValue?.(initialValue);
    this.state.editor.value = initialValue;
    this.state.editor.cursor = initialValue.length;
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
    await this.refreshRun();
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
    if (this.pendingInput?.kind !== 'project-path'
      && (handlesSetupScreen(this.state.screen) || handlesExportScreen(this.state.screen))) {
      return ZipflowController.prototype.handleEditorKey.call(this, key);
    }
    if (key.name === 'escape') {
      this.pendingInput = null;
      resetPathSuggestionInput(this.state);
      return this.runId ? this.refreshRun() : this.showProject();
    }
    if (['archive', 'project-path'].includes(this.pendingInput?.kind)) {
      if (isPlainEnter(key)
        && this.pendingInput.kind === 'archive'
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
          submit: () => this.pendingInput?.kind === 'archive'
            ? this.startArchive(this.state.editor.value)
            : this.openProjectPath(this.state.editor.value),
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
      if (pending?.kind === 'project-path') {
        resetPathSuggestionInput(this.state);
        return this.openProjectPath(value);
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
    if (['archive', 'project-path'].includes(this.pendingInput?.kind)
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
    return ZipflowController.prototype.toast.call(this, title, tone, _seconds, detail);
  }

  beginOperation(options) {
    return ZipflowController.prototype.beginOperation.call(this, options);
  }

  showMenu(screen, items, status = null, selectedIndex = 0, intro = []) {
    if (screen === 'archive-discovery') this.pendingInput = null;
    return ZipflowController.prototype.showMenu.call(
      this,
      screen,
      items,
      status,
      selectedIndex,
      intro,
    );
  }

  showHome() {
    return this.showProject();
  }

  async back() {
    if (handlesSetupScreen(this.state.screen)) return backSetup(this);
    if (handlesExportScreen(this.state.screen)) return backExport(this);
    if (handlesHistoryScreen(this.state.screen)) return backHistory(this);
    if (handlesReviewScreen(this.state.screen)) {
      const handled = backClientReview(this);
      if (handled !== false) return handled;
      if (this.state.screen === 'archive-safety') return false;
    }
    if (['run-file-groups', 'run-file-list', 'run-decisions'].includes(this.state.screen)) {
      const handled = backClientHistoryDetail(this);
      if (handled !== false) return handled;
    }
    if (this.state.screen === 'run-details') return this.showHistory();
    if (this.state.screen === 'archive-discovery') return this.promptArchive();
    if (this.state.screen === 'diff-view') return this.showPlan();
    if (this.state.screen === 'archive-input') return this.showProject();
    if (this.state.screen === 'manual-checks-result'
      || this.state.screen === 'manual-deploy-result') return this.showProject();
    if (this.state.screen === 'home' || this.state.screen === 'new-project') {
      this.setStatus('Use Exit or Ctrl+C to close Zipflow.');
      return false;
    }
    return this.showProject();
  }

  moveSelection(delta, { wrap = true } = {}) {
    const items = this.state.menuItems ?? [];
    if (!items.length) return;
    this.state.selectedIndex = moveSelectableIndex(items, this.state.selectedIndex, delta, { wrap });
  }

  async handleInterrupt() {
    if (this.operations.current) {
      return ZipflowController.prototype.handleInterrupt.call(this);
    }
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

  loadPlanItemDiff(item) {
    return loadClientPlanDiff(this, item);
  }

  startStartupUpdateCheck() {
    return ZipflowController.prototype.startStartupUpdateCheck.call(this);
  }

  requestRestart() {
    return ZipflowController.prototype.requestRestart.call(this);
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
    await this.operations.requestCancellation().catch(() => {});
    await this.operations.waitForSafeBoundary({ timeoutMs: this.fatalWaitMs });
    await this.stopProcesses().catch(() => {});
    await this.operations.waitForIdle({ timeoutMs: this.fatalWaitMs });
    await this.stopEvents();
    await this.connection?.close();
  }
}
