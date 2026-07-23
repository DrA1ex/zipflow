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
  WorkspacePane,
  WorkspaceShell,
  color,
  copyTextToClipboard,
  resolveWorkspaceShellLayout,
  scrollBy,
  themes,
  truncateVisible,
  visibleLength,
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
import { selectRowIndex, selectRows } from './select-rows.js';
import { translateForState as t } from '../i18n/index.js';
import { wheelScrollDelta } from './wheel.js';
import { overlayManagerWithoutToasts, renderZipflowToasts } from './toast-overlay.js';
import { commandLocationLabel } from '../project/command-spec.js';

export function renderZipflow({ state, width, height, animationFrame = 0 }) {
  const theme = themes[state.settings?.theme] ?? themes.ocean;
  const title = state.project?.name ? `Zipflow ${ZIPFLOW_VERSION} · ${state.project.name}` : `Zipflow ${ZIPFLOW_VERSION}`;
  const subtitle = state.project ? displayPath(state.project.root) : t(state, 'Safe source archive updates');
  state.statusDetail = state.screen === 'settings' ? runSettingsStatus(state) : '';
  const footerRight = (state.statusDetail ? [state.statusDetail] : [state.status]).filter(Boolean).map((value) => t(state, value));
  const footer = renderGlobalFooter({ left: footerHints(state).map((value) => t(state, value)), right: footerRight, width, theme });
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
    title: t(state, 'Zipflow needs more room'),
    message: t(state, 'Resize the terminal to at least 58×20.'),
    theme,
    children: shell,
  });
  const hosted = OverlayHost({
    content: responsive,
    manager: overlayManagerWithoutToasts(state.overlays),
    theme,
    width,
    height,
    toastBottomMargin: 0,
  });
  return renderZipflowToasts({ content: hosted, manager: state.overlays, theme, width, height, bottom: 2 });
}
function renderGlobalFooter({ left = [], right = [], width = 80, theme = null } = {}) {
  const separator = '  │  ';
  const innerWidth = Math.max(1, Number(width) - 4);
  const leftRaw = left.filter(Boolean).join(separator);
  const rightRaw = right.filter(Boolean).join(separator);
  const maxRightWidth = rightRaw ? Math.min(64, Math.max(0, Math.floor(innerWidth * 0.55))) : 0;
  let rightText = maxRightWidth >= 8 ? truncateVisible(rightRaw, maxRightWidth, '…') : '';
  const gap = rightText ? 2 : 0;
  let leftWidth = Math.max(1, innerWidth - visibleLength(rightText) - gap);
  let leftText = truncateVisible(leftRaw, leftWidth, '…');

  if (rightText && visibleLength(leftText) < Math.min(10, visibleLength(leftRaw))) {
    rightText = '';
    leftWidth = innerWidth;
    leftText = truncateVisible(leftRaw, leftWidth, '…');
  }

  const spacing = ' '.repeat(Math.max(0, innerWidth - visibleLength(leftText) - visibleLength(rightText)));
  const line = `${color(theme, 'textMuted', leftText)}${spacing}${rightText ? color(theme, 'textMuted', rightText) : ''}`;
  return Box({ border: true, borderColor: theme?.border, height: 3, padding: { left: 1, right: 1 } }, Text(line, { wrap: false }));
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
    ? ` ${t(state, 'Activity')} · ${t(state, '{count} new', { count: unread })} ↓ `
    : ` ${t(state, 'Activity')} `;
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
      state.transcriptScroll = scrollBy(state.transcriptScroll, wheelScrollDelta(event), maxScroll);
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
      if (result.copied) state.overlays?.toast?.(t(state, 'Activity text copied'), 'success', 2);
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
    Text(color(theme, 'accent', t(state, unread === 1
      ? '↓ {count} new Activity entry · click or press End'
      : '↓ {count} new Activity entries · click or press End', { count: unread })), { wrap: false }),
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
  const selectedContext = inlineDescriptions ? '' : t(state, contextText(selected));
  const introRows = intro.length ? Math.min(3, intro.length) + 1 : 0;
  const windowSize = Math.max(2, height - 4 - introRows - contextRows);
  state.menuPageSize = windowSize;
  const footerNode = ContextDock({ text: selectedContext, rows: contextRows, width: Math.max(20, width - 6), theme });
  const menuRows = selectRows(state.menuItems, (item) => menuItemLabel(item, state));
  return WorkspacePane({
    title: ` ${screenTitle(state)} `,
    active: true,
    height,
    theme,
    footerNode,
    footerMinHeight: contextRows,
    children: [
      ...intro.slice(0, 3).map((line, index) => Text(index === 0 ? color(theme, 'title', t(state, line)) : color(theme, 'textMuted', t(state, line)), { wrap: true })),
      intro.length ? Text('') : null,
      SelectList({
        title: t(state, 'Choose'),
        items: menuRows,
        selectedIndex: state.selectedIndex,
        windowSize,
        getLabel: (item) => item.label,
        getDisabled: (item) => item.disabled,
        wrapItems: false,
        maxItemLines: 1,
        theme,
        pointerId: 'zipflow:menu',
        onSelect: (item, index) => state.dispatch?.({ type: 'activate-index', index: selectRowIndex(item, index) }),
        onWheel: (event) => {
          const delta = wheelScrollDelta(event);
          if (delta) state.dispatch?.({ type: 'menu-move-selection', delta, wrap: false });
          event.preventDefault();
          event.stopPropagation?.();
        },
      }),
    ].filter(Boolean),
  });
}

function menuItemLabel(item, state) {
  const label = oneLineLabel(t(state, String(item?.label ?? '')));
  if (!label || /›\s*$/.test(label)) return label;
  if (item?.navigate || opensSubscreen(item?.id)) return `${label} ›`;
  return label;
}

function oneLineLabel(value) {
  return String(value ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/[\t ]{2,}/g, ' ')
    .trim();
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
    ?? (state.editorContext?.instructions ?? []).map((line) => t(state, line)).join(' · ');
  const editorHeight = Math.max(2, height - contextRows - 2);
  return Column({ height },
    ZipflowTextEditorView({
      title: ` ${t(state, state.editorContext?.label ?? screenTitle(state))} `,
      value: state.editor.value,
      cursor: state.editor.cursor,
      width,
      height: editorHeight,
      placeholder: t(state, state.editorContext?.placeholder ?? ''),
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
      Text(color(theme, 'title', t(state, state.busyLabel)), { wrap: true }),
      ...(state.progress.detail ? [Text(color(theme, 'textMuted', t(state, state.progress.detail)), { wrap: true })] : []),
      ProgressBar({ value: state.progress.value, total: Math.max(1, state.progress.total), width: 44, theme }),
      Text(color(theme, 'textMuted', t(state, 'Zipflow is preserving the project state while this step runs.')), { wrap: true }),
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
    return `${color(theme, token, status.padEnd(5))} ${commandLocationLabel(check.cwd)} · ${check.name}${duration}`;
  });
  if (state.settings.checkOutput === 'last-line' && runtime.lastLine) lines.push('', runtime.lastLine);
  return runtimePane(` ${t(state, 'Running checks')} `, lines, height, theme);
}

function renderDeployRunning(state, height, theme) {
  const runtime = state.deployRuntime ?? {};
  const lines = [
    `${color(theme, 'accent', 'RUN  ')} ${t(state, 'Deploy command')}`,
    `      ${t(state, 'Directory')}: ${commandLocationLabel(runtime.cwd)}`,
    runtime.commandText ? `      ${t(state, 'Command')}: ${runtime.commandText}` : '',
  ].filter(Boolean);
  if (state.settings.checkOutput === 'last-line' && runtime.lastLine) lines.push('', runtime.lastLine);
  return runtimePane(` ${t(state, 'Deploying')} `, lines, height, theme);
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
  if (!view?.diff) return WorkspacePane({ title: ` ${t(state, 'Diff').toUpperCase()} `, active: true, height, theme, children: [Text(t(state, 'Diff is unavailable.'))] });
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
  const hunkLabel = document.hunkCount ? ` · ${t(state, 'HUNK')} ${view.hunkIndex + 1}/${document.hunkCount}` : '';
  const fileLabel = view.files?.length > 1 ? ` · ${t(state, 'FILE')} ${(view.fileIndex ?? 0) + 1}/${view.files.length}` : '';
  return ScrollPane({
    title: ` ${view.diff.path} · ${t(state, view.mode === 'unified' ? 'UNIFIED' : 'SIDE BY SIDE')}${fileLabel}${hunkLabel} `,
    lines,
    width,
    height,
    scroll: view.scroll,
    footer: t(state, '{start}-{end} of {total} · N/P hunk · J/K file · M mode · Esc back', {
      start: view.scroll + 1, end: Math.min(lines.length, view.scroll + visibleRows), total: Math.max(1, lines.length),
    }),
    theme,
    pointerId: 'zipflow:diff',
    selection: state.diffSelection,
    onWheel: (event) => {
      view.scroll = scrollBy(view.scroll, wheelScrollDelta(event), maxScroll);
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
    'project-path-input': 'Choose project', 'project-entry-path': 'Add project', 'setup-project-confirm': 'Add project', 'setup-project-type': 'Project type', 'setup-checks': 'Checks', 'custom-check-command': 'Custom check command',
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
  return t(state, titles[state.screen] ?? 'Zipflow');
}

function footerHints(state) {
  if (state.screen === 'settings') {
    if (state.settingsPanel?.modal?.field?.path) return ['Tab open', 'Shift+Tab up', '↑/↓ choose', 'Enter save', 'Esc cancel'];
    if (state.settingsPanel?.modal) return ['Enter save', 'Esc cancel', 'Ctrl+B close'];
    if (state.settingsPanel?.choiceSearch?.active) return ['Type to filter', 'Enter keep', 'Esc clear/close'];
    return ['↑/↓', 'Enter', '/ models', 'Ctrl+B close'];
  }
  if (state.screen === 'diff-view') return ['↑/↓ scroll', 'N/P hunk', 'J/K file', 'M mode', 'Esc back'];
  if (state.llmAbortController) return ['Esc cancel LLM', 'Ctrl+C stop'];
  if (state.busy || ['checks-running', 'deploy-running', 'manual-checks-running', 'manual-deploy-running'].includes(state.screen)) return ['Ctrl+C stop'];
  if (state.menuSearch?.active) return ['Type to filter', 'Enter keep', 'Esc clear/close'];
  if (state.screen === 'setup-checks') return ['↑/↓ choose', 'Shift+↑/↓ move', 'Space toggle', 'Enter select', '? help'];
  if (isEditorScreen(state.screen)) {
    if (state.screen === 'commit-message') return ['Enter commit', 'Ctrl+Enter new line', 'Esc back'];
    if (['archive-input', 'project-path-input', 'project-entry-path', 'custom-check-command', 'deploy-command', 'export-path'].includes(state.screen)) return ['Tab open', 'Shift+Tab up', '↑/↓ choose', 'Enter confirm', 'Esc back'];
    return ['Enter confirm', 'Esc back'];
  }
  const report = state.run?.id ? ['G report'] : [];
  if (isSearchableScreen(state.screen)) return ['↑/↓ choose', 'PgUp/PgDn', 'Home/End', 'Enter select', '/ search', '? help', ...report];
  return ['↑/↓ choose', 'Enter select', '? help', ...report, 'Ctrl+B settings'];
}

function headerStats(state) {
  const step = runStep(state);
  const stats = [
    { label: t(state, 'State'), value: t(state, state.busy ? 'Working' : state.status) },
    { label: t(state, 'Policy'), value: t(state, state.workflow?.policy?.label ?? state.draft?.policy?.label ?? 'Not configured') },
  ];
  if (step) stats.push({ label: t(state, 'Stage'), value: `${step.number}/5 ${t(state, step.label)}` });
  return stats;
}

function preferredPromptHeight(state, width = 80, mainHeight = 20) {
  const compactMaximum = Math.max(7, Math.floor(mainHeight * 0.62));
  if (state.busy) return Math.min(compactMaximum, 9);
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
    'project-path-input', 'project-entry-path', 'archive-input', 'custom-check-command', 'custom-check-name',
    'commit-message', 'commit-template', 'deploy-command', 'export-path', 'initial-commit-message',
  ].includes(screen);
}

function renderMenuSearchOverlay(state, content, width, height, promptHeight, theme) {
  if (!state.menuSearch?.active) return content;
  const overlayWidth = Math.max(32, Math.min(width - 6, 72));
  const overlay = Box({ border: true, padding: { left: 1, right: 1 }, title: ` ${t(state, 'Search')} ` },
    ZipflowTextEditorView({
      title: ` ${t(state, 'Filter')} `,
      value: state.searchEditor.value,
      cursor: state.searchEditor.cursor,
      width: overlayWidth - 4,
      height: 3,
      placeholder: t(state, 'Type a path, name, or description'),
      lineNumbers: false,
      theme,
    }),
    Text(color(theme, 'textMuted', t(state, `${state.menuItems.length} matching item${state.menuItems.length === 1 ? '' : 's'} · Enter keeps filter · Esc clears/closes`)), { wrap: true }),
  );
  return BottomOverlay({ content, overlay, height, bottom: Math.max(1, promptHeight - 1), left: 2, right: 2, width: overlayWidth, align: 'center', opaque: true });
}
function contextRowsForScreen(screen) {
  return isWorkflowSetupScreen(screen) ? 2 : 1;
}
function showsInlineDescriptions(screen) {
  void screen;
  return false;
}
function isWorkflowSetupScreen(screen) {
  return String(screen ?? '').startsWith('setup-') || String(screen ?? '').startsWith('custom-check');
}
function isSearchableScreen(screen) {
  return String(screen ?? '').startsWith('setup-')
    || new Set(['plan-files', 'export-select', 'export-files', 'run-history', 'run-file-list']).has(screen);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
