import { InputEditor, createTextSelectionState } from 'terlio.js';
import { DEFAULT_SETTINGS } from '../settings/store.js';

export function createInitialState() {
  return {
    screen: 'boot',
    project: null,
    workflow: null,
    draft: null,
    setupEditing: false,
    setupReturnScreen: null,
    run: null,
    runSettings: null,
    archive: null,
    archiveMetadata: null,
    archiveSafety: null,
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
    busy: false,
    busyLabel: 'Starting…',
    progress: { value: 0, total: 1, detail: '' },
    checkRuntime: null,
    deployRuntime: null,
    postCheckContinuation: null,
    llmRuntime: null,
    llmAbortController: null,
    llmReviewPending: false,
    llmReviewPromise: null,
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
    recoveryContext: null,
    status: 'Starting',
    statusDetail: '',
    settings: { ...DEFAULT_SETTINGS },
    settingsPanel: null,
    overlays: null,
    helpToast: null,
    dispatch: null,
  };
}

export function setScreen(state, screen, { items = [], selectedIndex = 0, status = null, intro = [] } = {}) {
  state.screen = screen;
  state.menuSourceItems = Array.isArray(items) ? items : [];
  state.menuSearch = state.menuSearch?.screen === screen ? state.menuSearch : null;
  state.menuItems = applyMenuSearch(state.menuSourceItems, state.menuSearch?.query);
  state.selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, state.menuItems.length - 1)));
  state.panelIntro = Array.isArray(intro) ? intro : [String(intro ?? '')].filter(Boolean);
  if (status) state.status = status;
}

export function refreshMenuSearch(state, query) {
  if (!state.menuSearch) return;
  const selectedId = state.menuItems[state.selectedIndex]?.id;
  state.menuSearch.query = String(query ?? '');
  state.menuItems = applyMenuSearch(state.menuSourceItems, state.menuSearch.query);
  const preserved = state.menuItems.findIndex((item) => item.id === selectedId);
  state.selectedIndex = preserved >= 0 ? preserved : firstEnabledIndex(state.menuItems);
}

export function appendMessage(state, title, lines = [], tone = 'info', options = {}) {
  const normalized = Array.isArray(lines) ? lines : [String(lines)];
  const collapsible = options.collapsible ?? (tone !== 'project' && tone !== 'summary' && normalized.length > 3);
  state.messages.push({
    id: state.nextMessageId++, title, lines: normalized, tone,
    collapsedSummary: options.collapsedSummary ?? null,
    collapsible, collapsed: options.collapsed ?? collapsible, at: new Date().toISOString(),
  });
  noteActivityChange(state);
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
  return items.filter((item) => `${item.label ?? ''}\n${item.description ?? ''}\n${item.searchText ?? ''}`.toLowerCase().includes(normalized));
}

function firstEnabledIndex(items) {
  const index = items.findIndex((item) => !item.disabled);
  return index >= 0 ? index : 0;
}
