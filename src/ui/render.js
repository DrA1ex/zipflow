import {
  BottomOverlay,
  Box,
  Column,
  OverlayHost,
  PointerRegion,
  ProgressBar,
  RequireViewport,
  ScrollPane,
  SelectList,
  Text,
  WorkspaceFooter,
  WorkspacePane,
  WorkspaceShell,
  color,
  copyTextToClipboard,
  resolveWorkspaceShellLayout,
  scrollBy,
  themes,
  wrapText,
} from 'terlio.js';
import { displayPath } from '../utils/paths.js';
import { formatDuration, runStep } from './format.js';
import { renderDiffDocument } from '../diff/hunks.js';
import { ZIPFLOW_VERSION } from '../version.js';
import { buildTranscript } from './activity.js';
import { renderSettings } from './settings-view.js';
import { settingsViewModel } from '../app/settings-panel.js';
import { PathCompletionPopup } from './path-completion.js';
import { runSettingsStatus } from '../app/runtime-settings.js';
import { ZipflowTextEditorView } from './editor-view.js';
import { ContextDock, contextText } from './context-dock.js';

export function renderZipflow({ state, width, height, animationFrame = 0 }) {
  const theme = themes[state.settings?.theme] ?? themes.ocean;
  const title = state.project?.name ? `Zipflow ${ZIPFLOW_VERSION} · ${state.project.name}` : `Zipflow ${ZIPFLOW_VERSION}`;
  const subtitle = state.project ? displayPath(state.project.root) : 'Safe source archive updates';
  state.statusDetail = state.screen === 'settings' ? runSettingsStatus(state) : '';
  const footerRight = state.statusDetail ? [state.statusDetail] : [state.status].filter(Boolean);
  const footer = WorkspaceFooter({ title: '', left: footerHints(state), right: footerRight, theme });
  const { mainHeight } = resolveWorkspaceShellLayout({
    width,
    height,
    title,
    subtitle,
    stats: headerStats(state),
    right: [],
    focus: state.screen,
    main: Text(''),
    footer,
    theme,
    minMainHeight: 3,
  });
  const main = state.screen === 'settings'
    ? renderSettings(state, width, mainHeight, theme, animationFrame)
    : state.screen === 'diff-view'
      ? renderDiffView(state, width, mainHeight, theme)
      : renderWorkflow(state, width, mainHeight, theme);
  const shell = WorkspaceShell({
    title,
    subtitle,
    stats: headerStats(state),
    focus: state.screen,
    main,
    footer,
    height,
    theme,
  });
  const responsive = RequireViewport({
    width,
    height,
    minWidth: 58,
    minHeight: 20,
    title: 'Zipflow needs more room',
    message: 'Resize the terminal to at least 58×20.',
    theme,
    children: shell,
  });
  return OverlayHost({ content: responsive, manager: state.overlays, theme, width, height, toastBottomMargin: 2 });
}

function renderWorkflow(state, width, mainHeight, theme) {
  const promptHeight = Math.min(mainHeight - 4, preferredPromptHeight(state, width, mainHeight));
  const historyHeight = Math.max(4, mainHeight - promptHeight);
  let content = Column({ height: mainHeight },
    renderTranscript(state, width, historyHeight, theme),
    renderCurrent(state, width, promptHeight, theme),
  );
  content = renderPathSuggestionsOverlay(state, content, width, mainHeight, promptHeight, theme);
  return renderMenuSearchOverlay(state, content, width, mainHeight, promptHeight, theme);
}

function renderPathSuggestionsOverlay(state, content, width, height, promptHeight, theme) {
  const completion = state.pathSuggestions;
  if (!completion?.items?.length || completion.owner === 'settings-modal' || !state.pathSuggestionActive) return content;
  const overlayHeight = Math.min(7, Math.max(4, completion.items.length + 2));
  const suggestions = PathCompletionPopup({ state, width: Math.max(36, width - 6), height: overlayHeight, theme });
  return BottomOverlay({
    content,
    overlay: suggestions,
    height,
    bottom: promptHeight,
    left: 2,
    right: 2,
    width: Math.max(36, Math.min(width - 4, 86)),
    align: 'left',
    opaque: true,
  });
}

function renderTranscript(state, width, height, theme) {
  const transcript = buildTranscript(state, theme, width);
  const lines = transcript.lines;
  const visibleRows = Math.max(1, height - 3);
  const maxScroll = Math.max(0, lines.length - visibleRows);
  if (state.transcriptSticky) state.transcriptScroll = maxScroll;
  state.activityLayout = { ranges: transcript.ranges, visibleRows, maxScroll };
  const hasCollapsed = transcript.ranges.some((item) => item.collapsible);
  const unread = Math.max(0, Number(state.activityUnread) || 0);
  const activityTitle = unread && !state.transcriptSticky
    ? ` Activity · ${unread} new ↓ `
    : ' Activity ';
  const pane = ScrollPane({
    title: activityTitle,
    lines,
    width,
    height,
    scroll: state.transcriptScroll,
    footer: true,
    theme,
    pointerId: 'zipflow:transcript',
    onWheel: (event) => {
      state.transcriptScroll = scrollBy(state.transcriptScroll, event.deltaY, maxScroll);
      state.transcriptSticky = state.transcriptScroll >= maxScroll;
      if (state.transcriptSticky) state.activityUnread = 0;
      event.preventDefault();
    },
    onClick: (event) => {
      if (unread && Number(event.localY) >= height - 2) {
        state.dispatch?.({ type: 'activity-follow-latest' });
        event.preventDefault();
      }
    },
    selection: state.activitySelection,
    onSelectionChange: (text, _selection, event) => {
      if (text || event?.action !== 'release' || event?.button !== 'left') return;
      const row = Math.max(0, state.transcriptScroll + Math.trunc(Number(event.localY) || 0));
      state.dispatch?.({ type: 'activity-toggle-row', row });
    },
    onCopy: (text, _selection, _event, context) => {
      const result = copyTextToClipboard(text, { output: context.runtime.output });
      if (result.copied) state.overlays?.toast?.('Activity text copied', 'success', 2);
      else state.status = 'Clipboard transfer unavailable';
      return result.copied;
    },
  });
  if (!unread || state.transcriptSticky) return pane;
  const indicator = PointerRegion({
    pointerId: 'zipflow:activity-unread',
    pointerWidth: 'fill',
    onClick: (event) => {
      state.dispatch?.({ type: 'activity-follow-latest' });
      event.preventDefault();
      event.stopPropagation?.();
    },
  }, Box({ border: true, padding: { left: 1, right: 1 } },
    Text(color(theme, 'accent', `↓ ${unread} new Activity entr${unread === 1 ? 'y' : 'ies'} · click or press End`), { wrap: false }),
  ));
  return BottomOverlay({ content: pane, overlay: indicator, height, bottom: 1, left: 2, right: 2, align: 'center', opaque: true });
}

function renderCurrent(state, width, height, theme) {
  if (state.busy) return renderBusy(state, height, theme);
  if (isEditorScreen(state.screen)) return renderEditor(state, width, height, theme);
  if (['checks-running', 'manual-checks-running'].includes(state.screen)) return renderChecksRunning(state, height, theme);
  if (['deploy-running', 'manual-deploy-running'].includes(state.screen)) return renderDeployRunning(state, height, theme);
  const intro = state.panelIntro ?? [];
  const selected = state.menuItems[state.selectedIndex];
  const inlineDescriptions = showsInlineDescriptions(state.screen);
  const contextRows = inlineDescriptions ? 0 : contextRowsForScreen(state.screen);
  const selectedContext = inlineDescriptions ? '' : contextText(selected);
  const introRows = intro.length ? Math.min(3, intro.length) + 1 : 0;
  const windowSize = Math.max(2, height - 4 - introRows - contextRows);
  state.menuPageSize = windowSize;
  const footerNode = ContextDock({ text: selectedContext, rows: contextRows, width: Math.max(20, width - 6), theme });
  return WorkspacePane({
    title: ` ${screenTitle(state)} `,
    active: true,
    height,
    theme,
    footerNode,
    footerMinHeight: contextRows,
    children: [
      ...intro.slice(0, 3).map((line, index) => Text(index === 0 ? color(theme, 'title', line) : color(theme, 'textMuted', line), { wrap: true })),
      intro.length ? Text('') : null,
      SelectList({
        title: 'Choose',
        items: state.menuItems,
        selectedIndex: state.selectedIndex,
        windowSize,
        getLabel: (item) => menuItemLabel(item),
        getDescription: (item) => inlineDescriptions ? item.description ?? '' : '',
        getDisabled: (item) => item.disabled,
        wrapItems: inlineDescriptions,
        maxItemLines: inlineDescriptions ? 3 : 1,
        reserveItemLines: inlineDescriptions,
        theme,
        pointerId: 'zipflow:menu',
        onSelect: (_item, index) => state.dispatch?.({ type: 'activate-index', index }),
        onWheel: (event) => {
          const delta = event.deltaY < 0 ? -1 : 1;
          state.selectedIndex = clamp(state.selectedIndex + delta, 0, state.menuItems.length - 1);
          event.preventDefault();
        },
      }),
    ].filter(Boolean),
  });
}

function menuItemLabel(item) {
  const label = String(item?.label ?? '');
  if (!label || /›\s*$/.test(label)) return label;
  if (item?.navigate || opensSubscreen(item?.id)) return `${label} ›`;
  return label;
}

function opensSubscreen(id) {
  const value = String(id ?? '');
  return [
    'start-update', 'setup-project', 'choose-directory', 'create-zip', 'run-history', 'change-workflow',
    'view-plan', 'safety-review-plan', 'choose-conflicts', 'history-type-filter', 'history-status-filter',
    'history-analytics', 'view-report', 'view-run-files', 'rollback', 'edit-message', 'export-review-files',
    'export-sensitive-review', 'export-change-mode', 'export-choose-path', 'open-llm-settings', 'review-settings',
    'test-selected-model', 'model-test-connection', 'model-test-replay', 'recent-archives',
  ].includes(value)
    || /^(?:plan-category:|plan-file:|history:|run-group:|run-file:|section-|edit-)/.test(value);
}

function renderEditor(state, width, height, theme) {
  const contextRows = Math.max(1, Number(state.editorContext?.contextRows) || 1);
  const context = state.editorContext?.context
    ?? (state.editorContext?.instructions ?? []).join(' · ');
  const editorHeight = Math.max(2, height - contextRows - 2);
  return Column({ height },
    ZipflowTextEditorView({
      title: ` ${state.editorContext?.label ?? screenTitle(state)} `,
      value: state.editor.value,
      cursor: state.editor.cursor,
      width,
      height: editorHeight,
      placeholder: state.editorContext?.placeholder ?? '',
      lineNumbers: false,
      theme,
    }),
    ContextDock({ text: context, rows: contextRows, width: Math.max(20, width - 2), theme }),
  );
}

function renderBusy(state, height, theme) {
  return WorkspacePane({
    title: ` ${screenTitle(state)} `,
    active: true,
    height,
    theme,
    children: [
      Text(color(theme, 'title', state.busyLabel), { wrap: true }),
      ProgressBar({ value: state.progress.value, total: Math.max(1, state.progress.total), width: 44, label: state.progress.detail || undefined, theme }),
      Text(color(theme, 'textMuted', 'Zipflow is preserving the project state while this step runs.'), { wrap: true }),
    ],
  });
}

function renderChecksRunning(state, height, theme) {
  const runtime = state.checkRuntime ?? { checks: [], activeIndex: 0 };
  const lines = runtime.checks.map((check, index) => {
    const result = runtime.results?.find((item) => item.id === check.id);
    const status = result ? (result.ok ? 'PASS' : 'FAIL') : index === runtime.activeIndex ? 'RUN' : 'WAIT';
    const token = status === 'PASS' ? 'success' : status === 'FAIL' ? 'danger' : status === 'RUN' ? 'accent' : 'textMuted';
    const estimate = runtime.estimates?.[check.name];
    const duration = result ? ` ${formatDuration(result.durationMs)}` : estimate ? ` ~${formatDuration(estimate)}` : '';
    return `${color(theme, token, status.padEnd(5))} ${check.name}${duration}`;
  });
  if (state.settings.checkOutput === 'last-line' && runtime.lastLine) lines.push('', runtime.lastLine);
  return runtimePane(' Running checks ', lines, height, theme);
}

function renderDeployRunning(state, height, theme) {
  const runtime = state.deployRuntime ?? {};
  const lines = [
    `${color(theme, 'accent', 'RUN  ')} Deploy command`,
    runtime.commandText ? `      ${runtime.commandText}` : '',
  ].filter(Boolean);
  if (state.settings.checkOutput === 'last-line' && runtime.lastLine) lines.push('', runtime.lastLine);
  return runtimePane(' Deploying ', lines, height, theme);
}

function runtimePane(title, lines, height, theme) {
  return WorkspacePane({
    title,
    active: true,
    height,
    theme,
    children: lines.map((line) => Text(line, { wrap: !String(line).includes('\x1b[') })),
  });
}

function renderDiffView(state, width, height, theme) {
  const view = state.diffView;
  if (!view?.diff) return WorkspacePane({ title: ' DIFF ', active: true, height, theme, children: [Text('Diff is unavailable.')] });
  const contentWidth = Math.max(40, width - 4);
  const document = renderDiffDocument(view.diff, view.mode, contentWidth);
  view.hunkOffsets = document.hunkOffsets;
  view.hunkCount = document.hunkCount;
  view.hunkIndex = clamp(view.hunkIndex ?? 0, 0, Math.max(0, document.hunkCount - 1));
  if (view.pendingHunkJump) {
    view.scroll = document.hunkOffsets[view.hunkIndex] ?? 0;
    view.pendingHunkJump = false;
  }
  const lines = document.lines.map((line) => formatDiffLine(line, view.mode, theme));
  const visibleRows = Math.max(1, height - 4);
  const maxScroll = Math.max(0, lines.length - visibleRows);
  view.scroll = clamp(view.scroll, 0, maxScroll);
  const hunkLabel = document.hunkCount ? ` · HUNK ${view.hunkIndex + 1}/${document.hunkCount}` : '';
  const fileLabel = view.files?.length > 1 ? ` · FILE ${(view.fileIndex ?? 0) + 1}/${view.files.length}` : '';
  return ScrollPane({
    title: ` ${view.diff.path} · ${view.mode === 'unified' ? 'UNIFIED' : 'SIDE BY SIDE'}${fileLabel}${hunkLabel} `,
    lines,
    width,
    height,
    scroll: view.scroll,
    footer: `${view.scroll + 1}-${Math.min(lines.length, view.scroll + visibleRows)} of ${Math.max(1, lines.length)} · N/P hunk · J/K file · M mode · Esc back`,
    theme,
    pointerId: 'zipflow:diff',
    selection: state.diffSelection,
    onWheel: (event) => {
      const direction = event.deltaY < 0 ? -1 : 1;
      view.scroll = scrollBy(view.scroll, direction * 3, maxScroll);
      event.preventDefault();
      event.stopPropagation?.();
    },
    onCopy: (text, _selection, _event, context) => copyTextToClipboard(text, { output: context.runtime.output }).copied,
  });
}

function formatDiffLine(line, mode, theme) {
  if (typeof line === 'string') return line;
  if (mode === 'side-by-side') {
    const separator = color(theme, 'textMuted', ' │ ');
    if (line.type === 'hunk') return `${color(theme, 'accent', line.left)}${separator}${color(theme, 'accent', line.right)}`;
    if (line.type === 'separator') return `${color(theme, 'textMuted', line.left)}${separator}${color(theme, 'textMuted', line.right)}`;
    if (line.type === 'add') return `${color(theme, 'textMuted', line.left)}${separator}${color(theme, 'success', line.right)}`;
    if (line.type === 'remove') return `${color(theme, 'danger', line.left)}${separator}${color(theme, 'textMuted', line.right)}`;
    if (line.type === 'change') return `${color(theme, 'danger', line.left)}${separator}${color(theme, 'success', line.right)}`;
    return `${line.left}${separator}${line.right}`;
  }
  if (line.type === 'hunk') return color(theme, 'accent', line.text);
  if (line.type === 'separator') return color(theme, 'textMuted', line.text);
  if (line.type === 'add') return color(theme, 'success', line.text);
  if (line.type === 'remove') return color(theme, 'danger', line.text);
  return line.text;
}

function screenTitle(state) {
  const titles = {
    boot: 'Starting', home: 'Project', 'new-project': 'Project', 'setup-project': 'Project setup', 'setup-sections': 'Workflow sections',
    'project-path-input': 'Choose project', 'setup-checks': 'Checks', 'custom-check-command': 'Custom check command',
    'custom-check-name': 'Custom check name', 'setup-policy': 'Update policy', 'setup-archive-mode': 'Archive mode',
    'setup-deletion-scope': 'Snapshot deletion', 'setup-git-checkpoint': 'Git checkpoint',
    'setup-git-result': 'Result commit', 'setup-git-message': 'Commit message source', 'commit-template': 'Commit template',
    'setup-deploy': 'Deployment', 'setup-deploy-command': 'Deploy command', 'deploy-command': 'Deploy command', 'setup-review': 'Review',
    'archive-input': 'Archive', 'archive-duplicate': 'Archive already used', 'archive-root-choice': 'Archive root', 'archive-safety': 'Archive safety', 'plan-review': 'Update plan', 'plan-details': 'Change groups', 'plan-files': 'Changed files', 'plan-file-choice': 'File decision', 'diff-view': 'Diff',
    'conflict-summary': 'Conflict choices', 'conflict-checkpoint': 'Conflict checkpoint', 'conflict-file': 'Resolve conflict', conflicts: 'Choose files',
    applying: 'Applying update', 'autopilot-decision': 'Autopilot decision', 'checks-running': 'Checks', 'check-failed': 'Checks failed', commit: 'Commit',
    'commit-message': 'Commit message', 'deploy-prompt': 'Deployment', 'deploy-running': 'Deployment',
    'deploy-failed': 'Deployment failed', completed: 'Completed', 'run-details': 'Last run', 'run-file-groups': 'Changed files', 'run-file-list': 'Changed files',
    'rollback-confirm': 'Rollback', 'rolling-back': 'Rolling back',
    'export-mode': 'Create ZIP', 'export-select': 'Choose archive contents', 'export-sensitive': 'ZIP safety review', 'export-protected': 'Protected project data', 'export-preview': 'ZIP preview', 'export-files': 'Included files', 'export-path': 'Output archive',
    'export-overwrite': 'Replace archive', 'export-running': 'Creating ZIP', 'export-complete': 'ZIP created',
    'setup-git-init': 'Initialize Git', 'setup-gitignore': 'Git ignore rules',
    'setup-initial-commit': 'First commit', 'initial-commit-message': 'First commit message',
    'run-history': 'Run history', 'run-history-filter': 'Filter run history', 'run-analytics': 'Performance analytics',
    'manual-checks-running': 'Running tests', 'manual-checks-result': 'Test report',
    'manual-deploy-running': 'Deployment', 'manual-deploy-result': 'Deployment report',
    error: 'Error', settings: 'Settings',
  };
  return titles[state.screen] ?? 'Zipflow';
}

function footerHints(state) {
  if (state.screen === 'settings') {
    if (state.settingsPanel?.modal) return ['Enter save', 'Esc cancel', 'Ctrl+B close'];
    if (state.settingsPanel?.choiceSearch?.active) return ['Type to filter', 'Enter keep', 'Esc clear/close'];
    return ['↑/↓', 'Enter', '/ models', 'Ctrl+B close'];
  }
  if (state.screen === 'diff-view') return ['↑/↓ scroll', 'N/P hunk', 'J/K file', 'M mode', 'Esc back'];
  if (state.llmAbortController) return ['Esc cancel LLM', 'Ctrl+C stop'];
  if (state.busy || ['checks-running', 'deploy-running', 'manual-checks-running', 'manual-deploy-running'].includes(state.screen)) return ['Ctrl+C stop'];
  if (state.menuSearch?.active) return ['Type to filter', 'Enter keep', 'Esc clear/close'];
  if (isEditorScreen(state.screen)) {
    if (state.screen === 'commit-message') return ['Enter commit', 'Ctrl+Enter new line', 'Esc back'];
    if (['archive-input', 'project-path-input', 'export-path'].includes(state.screen)) return ['Tab complete', '↑/↓ choose', 'Enter confirm', 'Esc back'];
    return ['Enter confirm', 'Esc back'];
  }
  const report = state.run?.id ? ['G report'] : [];
  if (isSearchableScreen(state.screen)) return ['↑/↓ choose', 'PgUp/PgDn', 'Home/End', 'Enter select', '/ search', '? help', ...report];
  return ['↑/↓ choose', 'Enter select', '? help', ...report, 'Ctrl+B settings'];
}

function headerStats(state) {
  const step = runStep(state);
  const stats = [
    { label: 'State', value: state.busy ? 'Working' : state.status },
    { label: 'Policy', value: state.workflow?.policy?.label ?? state.draft?.policy?.label ?? 'Not configured' },
  ];
  if (step) stats.push({ label: 'Stage', value: `${step.number}/5 ${step.label}` });
  return stats;
}

function preferredPromptHeight(state, width = 80, mainHeight = 20) {
  const compactMaximum = Math.max(7, Math.floor(mainHeight * 0.62));
  if (state.busy) return Math.min(compactMaximum, 8);
  if (state.screen === 'setup-review') return Math.min(compactMaximum, 8);
  if (['checks-running', 'manual-checks-running'].includes(state.screen)) {
    return Math.min(compactMaximum, Math.max(9, Math.min(12, (state.checkRuntime?.checks?.length ?? 0) + 5)));
  }
  if (['deploy-running', 'manual-deploy-running'].includes(state.screen)) return Math.min(compactMaximum, 9);
  if (isEditorScreen(state.screen)) return Math.min(compactMaximum, state.editorContext?.multiline ? 13 : 9);
  const count = state.menuItems?.length ?? 0;
  const historyScreen = ['run-history', 'run-details', 'run-file-groups', 'run-file-list', 'run-analytics'].includes(state.screen);
  const desiredItems = count <= 3 ? count : historyScreen ? Math.min(16, Math.max(6, count)) : Math.min(9, Math.max(4, count));
  const introRows = state.panelIntro?.length ? Math.min(3, state.panelIntro.length) + 1 : 0;
  const chromeRows = 4 + introRows + contextRowsForScreen(state.screen);
  const requested = Math.max(7, desiredItems + chromeRows);
  const maximum = historyScreen ? Math.max(7, mainHeight - 4) : compactMaximum;
  return Math.min(maximum, requested);
}

function isEditorScreen(screen) {
  return [
    'project-path-input', 'archive-input', 'custom-check-command', 'custom-check-name',
    'commit-message', 'commit-template', 'deploy-command', 'export-path', 'initial-commit-message',
  ].includes(screen);
}

function renderMenuSearchOverlay(state, content, width, height, promptHeight, theme) {
  if (!state.menuSearch?.active) return content;
  const overlayWidth = Math.max(32, Math.min(width - 6, 72));
  const overlay = Box({ border: true, padding: { left: 1, right: 1 }, title: ' Search ' },
    ZipflowTextEditorView({
      title: ' Filter ',
      value: state.searchEditor.value,
      cursor: state.searchEditor.cursor,
      width: overlayWidth - 4,
      height: 3,
      placeholder: 'Type a path, name, or description',
      lineNumbers: false,
      theme,
    }),
    Text(color(theme, 'textMuted', `${state.menuItems.length} matching item${state.menuItems.length === 1 ? '' : 's'} · Enter keeps filter · Esc clears/closes`), { wrap: true }),
  );
  return BottomOverlay({ content, overlay, height, bottom: Math.max(1, promptHeight - 1), left: 2, right: 2, width: overlayWidth, align: 'center', opaque: true });
}
function contextRowsForScreen(_screen) {
  return 1;
}
function showsInlineDescriptions(screen) {
  return isWorkflowSetupScreen(screen);
}
function isWorkflowSetupScreen(screen) {
  return String(screen ?? '').startsWith('setup-') || String(screen ?? '').startsWith('custom-check');
}
function isSearchableScreen(screen) {
  return new Set(['plan-files', 'export-select', 'export-files', 'run-history', 'setup-checks', 'run-file-list']).has(screen);
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
