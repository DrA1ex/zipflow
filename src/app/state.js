import { InputEditor, createTextSelectionState } from 'terlio.js';
import { DEFAULT_SETTINGS } from '../settings/store.js';
import { normalizeSelectableIndex } from './list-navigation.js';
import { operationBlocksActions, operationCapabilities, operationState } from '../operations/state.js';

export function createInitialState() {
  const state = {
    screen: 'boot',
    project: null,
    workflow: null,
    draft: null,
    setupEditing: false,
    setupReturnScreen: null,
    setupProjectSnapshot: null,
    pendingProjectEntry: null,
    run: null,
    runSettings: null,
    archive: null,
    archiveMetadata: null,
    archiveSafety: null,
    archiveInterpretation: null,
    plan: null,
    decisions: new Map(),
    messages: [],
    nextMessageId: 1,
    activityLayout: null,
    menuItems: [],
    menuSourceItems: [],
    selectedIndex: 0,
    menuSearch: null,
    searchEditor: new InputEditor(),
    editor: new InputEditor(),
    editorContext: null,
    pathSuggestions: null,
    pathSuggestionActive: false,
    busyLabel: 'Starting…',
    activeOperation: null,
    updateCheck: null,
    updatePrompt: null,
    inputGeneration: 0,
    screenGeneration: 0,
    menuActivationBarrier: null,
    pathSuggestionAbortController: null,
    progress: { value: 0, total: 1, detail: '' },
    checkRuntime: null,
    deployRuntime: null,
    postCheckContinuation: null,
    llmRuntime: null,
    llmAbortController: null,
    llmReviewPending: false,
    llmReviewCancelling: false,
    llmReviewPromise: null,
    llmReviewInput: null,
    llmReviewSkippedByUser: false,
    llmReviewGeneration: 0,
    exportAbortController: null,
    exportDraft: null,
    transcriptScroll: 0,
    transcriptSticky: true,
    activityUnread: 0,
    activitySelection: createTextSelectionState(),
    diffSelection: createTextSelectionState(),
    panelIntro: [],
    diffView: null,
    planReview: null,
    conflictReview: null,
    reviewActions: null,
    historyRuns: [],
    historyFilter: 'all',
    historyTypeFilter: 'all',
    historyStatusFilter: 'all',
    runDetailsOrigin: null,
    pendingArchive: null,
    archiveDiscoveryTap: null,
    archiveDiscoveryCandidates: [],
    recoveryContext: null,
    status: 'Starting',
    statusDetail: '',
    settings: { ...DEFAULT_SETTINGS },
    i18n: null,
    settingsPanel: null,
    overlays: null,
    dispatch: null,
  };
  Object.defineProperties(state, {
    busy: {
      enumerable: true,
      configurable: false,
      get() { return operationBlocksActions(this.activeOperation); },
    },
    operationState: {
      enumerable: true,
      configurable: false,
      get() { return operationState(this.activeOperation); },
    },
    operationCapabilities: {
      enumerable: true,
      configurable: false,
      get() { return operationCapabilities(this.activeOperation); },
    },
  });
  return state;
}

export function setScreen(state, screen, { items = [], selectedIndex = 0, status = null, intro = [] } = {}) {
  transitionScreen(state, screen);
  state.menuSourceItems = Array.isArray(items) ? items : [];
  state.menuSearch = state.menuSearch?.screen === screen ? state.menuSearch : null;
  state.menuItems = applyOperationGuard(state, applyMenuSearch(state.menuSourceItems, state.menuSearch?.query));
  state.selectedIndex = normalizeSelectableIndex(state.menuItems, selectedIndex);
  state.panelIntro = Array.isArray(intro) ? intro : [String(intro ?? '')].filter(Boolean);
  if (status) state.status = status;
}

export function refreshMenuSearch(state, query) {
  if (!state.menuSearch) return;
  const selectedId = state.menuItems[state.selectedIndex]?.id;
  state.menuSearch.query = String(query ?? '');
  state.menuItems = applyOperationGuard(state, applyMenuSearch(state.menuSourceItems, state.menuSearch.query));
  const preserved = state.menuItems.findIndex((item) => item.id === selectedId);
  state.selectedIndex = normalizeSelectableIndex(state.menuItems, preserved >= 0 ? preserved : state.selectedIndex);
}


export function transitionScreen(state, screen) {
  const next = String(screen ?? 'boot');
  const changed = state.screen !== next;
  state.pathSuggestionAbortController?.abort?.(changed ? 'screen-changed' : 'screen-refreshed');
  state.pathSuggestionAbortController = null;
  state.pathSuggestions = null;
  state.screen = next;
  if (state.menuActivationBarrier?.screen !== next) state.menuActivationBarrier = null;
  state.screenGeneration = (Number(state.screenGeneration) || 0) + 1;
  return changed;
}

export function applyOperationSnapshot(state, operation) {
  state.activeOperation = operation;
  if (operation?.label) state.busyLabel = operation.label;
  state.menuItems = applyOperationGuard(state, applyMenuSearch(state.menuSourceItems, state.menuSearch?.query));
  state.selectedIndex = normalizeSelectableIndex(state.menuItems, state.selectedIndex);
}

export function screenGenerationToken(state) {
  return { screen: state.screen, generation: Number(state.screenGeneration) || 0 };
}

export function isScreenGenerationCurrent(state, token) {
  return Boolean(token && state.screen === token.screen
    && (Number(state.screenGeneration) || 0) === (Number(token.generation) || 0));
}

function applyOperationGuard(state, items) {
  if (!operationBlocksActions(state.activeOperation)) return items;
  return items.map((item) => item.allowDuringOperation ? item : {
    ...item,
    disabled: true,
    disabledReason: item.disabledReason || `Wait for ${state.activeOperation?.label || 'the active operation'} to finish.`,
  });
}

export function appendMessage(state, title, lines = [], tone = 'info', options = {}) {
  return insertMessage(state, state.messages.length, title, lines, tone, options);
}

export function insertMessage(state, index, title, lines = [], tone = 'info', options = {}) {
  const normalized = Array.isArray(lines) ? lines : [String(lines)];
  const collapsible = options.collapsible ?? (tone !== 'project' && tone !== 'summary' && normalized.length > 3);
  const message = {
    id: state.nextMessageId++, title, lines: normalized, tone,
    collapsedSummary: options.collapsedSummary ?? null,
    collapsible, collapsed: options.collapsed ?? collapsible, at: new Date().toISOString(),
  };
  const target = Math.max(0, Math.min(state.messages.length, Number(index) || 0));
  state.messages.splice(target, 0, message);
  noteActivityChange(state);
  return message;
}

export function upsertMessage(state, key, title, lines = [], tone = 'info', options = {}) {
  const existing = state.messages.find((item) => item.key === key);
  if (!existing) {
    appendMessage(state, title, lines, tone, { ...options, key });
    state.messages[state.messages.length - 1].key = key;
    return state.messages[state.messages.length - 1];
  }
  const normalized = Array.isArray(lines) ? lines : [String(lines)];
  const collapsible = options.collapsible ?? (tone !== 'project' && tone !== 'summary' && normalized.length > 3);
  Object.assign(existing, {
    key, title, lines: normalized, tone, collapsible,
    collapsedSummary: options.collapsedSummary ?? existing.collapsedSummary ?? null,
    collapsed: options.collapsed ?? (collapsible ? existing.collapsed ?? false : false),
    at: new Date().toISOString(),
  });
  noteActivityChange(state);
  return existing;
}

export function replaceLastMessage(state, title, lines = [], tone = 'info', options = {}) {
  if (!state.messages.length) {
    appendMessage(state, title, lines, tone, options);
    return;
  }
  const current = state.messages[state.messages.length - 1];
  const normalized = Array.isArray(lines) ? lines : [String(lines)];
  const collapsible = options.collapsible ?? (tone !== 'project' && tone !== 'summary' && normalized.length > 3);
  state.messages[state.messages.length - 1] = {
    ...current, title, lines: normalized, tone, collapsible,
    collapsedSummary: options.collapsedSummary ?? current.collapsedSummary ?? null,
    collapsed: collapsible ? current.collapsed ?? true : false,
    at: new Date().toISOString(),
  };
}

function noteActivityChange(state) {
  if (state.transcriptSticky) return;
  state.activityUnread = Math.max(0, Number(state.activityUnread) || 0) + 1;
}

function applyMenuSearch(items, query) {
  const normalized = String(query ?? '').trim().toLowerCase();
  if (!normalized) return [...items];
  return items.filter((item) => `${item.label ?? ''}\n${item.value ?? ''}\n${item.context ?? ''}\n${item.description ?? ''}\n${item.help ?? ''}\n${item.searchText ?? ''}`.toLowerCase().includes(normalized));
}

