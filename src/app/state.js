import { InputEditor, createTextSelectionState } from 'terlio.js';
import { DEFAULT_SETTINGS } from '../settings/store.js';

export function createInitialState() {
  return {
    screen: 'boot',
    project: null,
    workflow: null,
    draft: null,
    run: null,
    archive: null,
    archiveMetadata: null,
    archiveSafety: null,
    plan: null,
    decisions: new Map(),
    messages: [],
    menuItems: [],
    selectedIndex: 0,
    editor: new InputEditor(),
    editorContext: null,
    busy: false,
    busyLabel: 'Starting…',
    progress: { value: 0, total: 1, detail: '' },
    checkRuntime: null,
    deployRuntime: null,
    llmRuntime: null,
    llmAbortController: null,
    exportDraft: null,
    transcriptScroll: 0,
    transcriptSticky: true,
    activitySelection: createTextSelectionState(),
    diffSelection: createTextSelectionState(),
    panelIntro: [],
    diffView: null,
    planReview: null,
    conflictReview: null,
    reviewActions: null,
    historyRuns: [],
    runDetailsOrigin: null,
    pendingArchive: null,
    status: 'Starting',
    settings: { ...DEFAULT_SETTINGS },
    settingsPanel: null,
    dispatch: null,
  };
}

export function setScreen(state, screen, { items = [], selectedIndex = 0, status = null, intro = [] } = {}) {
  state.screen = screen;
  state.menuItems = items;
  state.selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, items.length - 1)));
  state.panelIntro = Array.isArray(intro) ? intro : [String(intro ?? '')].filter(Boolean);
  if (status) state.status = status;
}

export function appendMessage(state, title, lines = [], tone = 'info') {
  state.messages.push({ title, lines: Array.isArray(lines) ? lines : [String(lines)], tone, at: new Date().toISOString() });
  state.transcriptSticky = true;
}

export function replaceLastMessage(state, title, lines = [], tone = 'info') {
  if (state.messages.length) state.messages[state.messages.length - 1] = { title, lines, tone, at: new Date().toISOString() };
  else appendMessage(state, title, lines, tone);
  state.transcriptSticky = true;
}
