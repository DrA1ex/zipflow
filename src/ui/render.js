import {
  BottomOverlay,
  Column,
  ProgressBar,
  RequireViewport,
  ScrollPane,
  SelectList,
  Text,
  TextEditorView,
  WorkspaceFooter,
  WorkspacePane,
  WorkspaceShell,
  color,
  copyTextToClipboard,
  resolveWorkspaceShellLayout,
  scrollBy,
  themes,
} from 'terlio.js';
import { displayPath } from '../utils/paths.js';
import { formatDuration, runStep } from './format.js';
import { renderDiffDocument } from '../diff/hunks.js';
import { ZIPFLOW_VERSION } from '../version.js';
import { buildTranscript } from './activity.js';
import { renderSettings } from './settings-view.js';
import { settingsViewModel } from '../app/settings-panel.js';
import { PathCompletionPopup } from './path-completion.js';

export function renderZipflow({ state, width, height }) {
  const theme = themes[state.settings?.theme] ?? themes.ocean;
  const title = state.project?.name ? `Zipflow ${ZIPFLOW_VERSION} · ${state.project.name}` : `Zipflow ${ZIPFLOW_VERSION}`;
  const subtitle = state.project ? displayPath(state.project.root) : 'Safe source archive updates';
  const footer = WorkspaceFooter({ left: footerHints(state), right: [state.status], theme });
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
    ? renderSettings(state, width, mainHeight, theme)
    : state.screen === 'diff-view'
      ? renderDiffView(state, width, mainHeight, theme)
      : renderWorkflow(state, width, mainHeight, theme);
  return RequireViewport({
    width,
    height,
    minWidth: 58,
    minHeight: 20,
    title: 'Zipflow needs more room',
    message: 'Resize the terminal to at least 58×20.',
    theme,
    children: WorkspaceShell({
      title,
      subtitle,
      stats: headerStats(state),
      focus: state.screen,
      main,
      footer,
      height,
      theme,
    }),
  });
}

function renderWorkflow(state, width, mainHeight, theme) {
  const promptHeight = Math.min(mainHeight - 4, preferredPromptHeight(state));
  const historyHeight = Math.max(4, mainHeight - promptHeight);
  const content = Column({ height: mainHeight },
    renderTranscript(state, width, historyHeight, theme),
    renderCurrent(state, width, promptHeight, theme),
  );
  return renderPathSuggestionsOverlay(state, content, width, mainHeight, promptHeight, theme);
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
  return ScrollPane({
    title: ' Activity ',
    lines,
    width,
    height,
    scroll: state.transcriptScroll,
    footer: state.transcriptSticky
      ? `following latest${hasCollapsed ? ' · E expand block at top' : ''}`
      : `PgDn to return${hasCollapsed ? ' · E expand/collapse block at top' : ''}`,
    theme,
    pointerId: 'zipflow:transcript',
    onWheel: (event) => {
      state.transcriptScroll = scrollBy(state.transcriptScroll, event.deltaY, maxScroll);
      state.transcriptSticky = state.transcriptScroll >= maxScroll;
      event.preventDefault();
    },
    selection: state.activitySelection,
    onCopy: (text, _selection, _event, context) => {
      const result = copyTextToClipboard(text, { output: context.runtime.output });
      state.status = result.copied ? 'Activity text copied' : 'Clipboard transfer unavailable';
      return result.copied;
    },
  });
}

function renderCurrent(state, width, height, theme) {
  if (state.busy) return renderBusy(state, height, theme);
  if (isEditorScreen(state.screen)) return renderEditor(state, width, height, theme);
  if (['checks-running', 'manual-checks-running'].includes(state.screen)) return renderChecksRunning(state, height, theme);
  if (['deploy-running', 'manual-deploy-running'].includes(state.screen)) return renderDeployRunning(state, height, theme);
  const intro = state.panelIntro ?? [];
  return WorkspacePane({
    title: ` ${screenTitle(state)} `,
    active: true,
    height,
    theme,
    children: [
      ...intro.map((line, index) => Text(index === 0 ? color(theme, 'title', line) : color(theme, 'textMuted', line), { wrap: true })),
      intro.length ? Text('') : null,
      SelectList({
        title: 'Choose',
        items: state.menuItems,
        selectedIndex: state.selectedIndex,
        windowSize: Math.max(2, height - 6 - Math.min(6, intro.length)),
        getLabel: (item) => item.label,
        getDescription: (item) => item.description ?? '',
        getDisabled: (item) => item.disabled,
        wrapItems: true,
        maxItemLines: 3,
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

function renderEditor(state, width, height, theme) {
  const instructions = state.editorContext?.instructions ?? [];
  const instructionNodes = instructions.map((line) => Text(color(theme, 'textMuted', line), { wrap: true }));
  const editorHeight = Math.max(2, height - 5 - instructions.length * 2);
  return WorkspacePane({
    title: ` ${screenTitle(state)} `,
    active: true,
    height,
    theme,
    children: [
      ...instructionNodes,
      instructions.length ? Text('') : null,
      TextEditorView({
        title: state.editorContext?.label ?? ' Input ',
        value: state.editor.value,
        cursor: state.editor.cursor,
        width: Math.max(20, width - 4),
        height: editorHeight,
        placeholder: state.editorContext?.placeholder ?? '',
        lineNumbers: false,
      }),
    ].filter(Boolean),
  });
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
    const status = result ? (result.ok ? 'PASS' : 'FAIL') : index === runtime.activeIndex ? 'RUN ' : 'WAIT';
    const estimate = runtime.estimates?.[check.name];
    const duration = result ? ` ${formatDuration(result.durationMs)}` : estimate ? ` ~${formatDuration(estimate)}` : '';
    return `${status.padEnd(5)} ${check.name}${duration}`;
  });
  if (state.settings.checkOutput === 'last-line' && runtime.lastLine) lines.push('', runtime.lastLine);
  return runtimePane(' Running checks ', lines, height, theme);
}

function renderDeployRunning(state, height, theme) {
  const runtime = state.deployRuntime ?? {};
  const lines = [
    'RUN   Deploy command',
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
    children: lines.map((line) => Text(line, { wrap: true })),
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
  return ScrollPane({
    title: ` ${view.diff.path} · ${view.mode === 'unified' ? 'UNIFIED' : 'SIDE BY SIDE'}${hunkLabel} `,
    lines,
    width,
    height,
    scroll: view.scroll,
    footer: `${view.scroll + 1}-${Math.min(lines.length, view.scroll + visibleRows)} of ${Math.max(1, lines.length)} · N/P hunk · M mode · Esc back`,
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
    boot: 'Starting', home: 'Project', 'new-project': 'Project', 'setup-project': 'Project setup',
    'project-path-input': 'Choose project', 'setup-checks': 'Checks', 'custom-check-command': 'Custom check command',
    'custom-check-name': 'Custom check name', 'setup-policy': 'Update policy', 'setup-archive-mode': 'Archive mode',
    'setup-deletion-scope': 'Snapshot deletion', 'setup-git-checkpoint': 'Git checkpoint',
    'setup-git-result': 'Result commit', 'setup-git-message': 'Commit message source', 'commit-template': 'Commit template',
    'setup-deploy': 'Deployment', 'setup-deploy-command': 'Deploy command', 'deploy-command': 'Deploy command', 'setup-review': 'Review',
    'archive-input': 'Archive', 'archive-duplicate': 'Archive already used', 'archive-root-choice': 'Archive root', 'archive-safety': 'Archive safety', 'plan-review': 'Update plan', 'plan-details': 'Change groups', 'plan-files': 'Changed files', 'diff-view': 'Diff',
    'conflict-summary': 'Conflict choices', 'conflict-checkpoint': 'Conflict checkpoint', 'conflict-file': 'Resolve conflict', conflicts: 'Choose files',
    applying: 'Applying update', 'checks-running': 'Checks', 'check-failed': 'Checks failed', commit: 'Commit',
    'commit-message': 'Commit message', 'deploy-prompt': 'Deployment', 'deploy-running': 'Deployment',
    'deploy-failed': 'Deployment failed', completed: 'Completed', 'run-details': 'Last run', 'run-file-groups': 'Changed files', 'run-file-list': 'Changed files',
    'rollback-confirm': 'Rollback', 'rolling-back': 'Rolling back',
    'export-mode': 'Create ZIP', 'export-select': 'Choose archive contents', 'export-preview': 'ZIP preview', 'export-files': 'Included files', 'export-path': 'Output archive',
    'export-running': 'Creating ZIP', 'export-complete': 'ZIP created',
    'setup-git-init': 'Initialize Git', 'setup-gitignore': 'Git ignore rules',
    'setup-initial-commit': 'First commit', 'initial-commit-message': 'First commit message',
    'run-history': 'Run history', 'run-analytics': 'Performance analytics',
    'manual-checks-running': 'Running tests', 'manual-checks-result': 'Test report',
    'manual-deploy-running': 'Deployment', 'manual-deploy-result': 'Deployment report',
    error: 'Error', settings: 'Settings',
  };
  return titles[state.screen] ?? 'Zipflow';
}

function footerHints(state) {
  if (state.screen === 'settings') {
    if (state.settingsPanel?.modal) return ['Enter save', 'Esc cancel', 'Tab/Enter complete path', 'Ctrl+B close settings'];
    if (state.settingsPanel?.focus === 'model-config') {
      return state.settingsPanel?.modelConfig?.focus === 'choices'
        ? ['↑/↓ choose', 'Enter apply', 'Esc return to model parameters', 'Ctrl+B close']
        : ['↑/↓ parameter', 'Enter open/use', 'Esc return to model list', 'Ctrl+B close'];
    }
    if (state.settingsPanel?.focus === 'choices') {
      const destination = settingsViewModel(state).direct ? 'categories' : 'parameter';
      return ['↑/↓ choose', 'Enter apply', `Esc return to ${destination}`, 'Ctrl+B close'];
    }
    if (state.settingsPanel?.focus === 'parameters') return ['↑/↓ parameter', 'Enter open', 'Esc return to categories', 'Ctrl+B close'];
    return ['↑/↓ category', 'Enter open page', 'Esc or Ctrl+B close', 'Ctrl+T native select'];
  }
  if (state.screen === 'diff-view') return ['↑/↓ scroll', 'N/P next/previous hunk', 'M switch mode', 'Drag to copy', 'Esc back'];
  if (state.llmAbortController) return ['Esc cancel LLM generation', 'Ctrl+C stop'];
  if (state.busy || ['checks-running', 'deploy-running', 'manual-checks-running', 'manual-deploy-running'].includes(state.screen)) return ['Ctrl+C stop'];
  if (isEditorScreen(state.screen)) return state.editorContext?.multiline
    ? ['Enter confirm', 'Ctrl+Enter newline', 'Ctrl+U clear to cursor', 'Esc back', 'Ctrl+T native select']
    : ['Enter confirm', 'Tab complete path', 'Esc back', 'Ctrl+B settings', 'Ctrl+T native select'];
  if (state.screen === 'setup-checks') return ['↑/↓ choose', 'Space toggle', 'A add', 'E edit', 'Del remove', 'Enter continue/open', 'Ctrl+B settings'];
  if (state.screen === 'conflict-file') return ['A archive', 'L local', 'D diff', 'Enter action', 'Esc back'];
  if (state.screen === 'conflicts') return ['↑/↓ choose', 'Space toggle decision', 'Enter action', 'Esc back', 'Ctrl+T native select'];
  if (state.screen === 'export-select' || state.screen === 'export-files') return ['↑/↓ choose', 'Enter/Space toggle', 'Esc back', 'Ctrl+T native select'];
  return ['↑/↓ choose', 'Enter/Space select', '? help', 'Drag Activity to copy', 'PgUp/PgDn activity', 'Ctrl+T native select', 'Ctrl+B settings'];
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

function preferredPromptHeight(state) {
  if (state.screen === 'home') return 14;
  if (['archive-root-choice', 'archive-safety', 'plan-review', 'plan-details', 'plan-files', 'conflict-summary', 'conflict-file', 'run-history', 'run-analytics', 'run-file-groups', 'run-file-list', 'export-preview', 'export-files'].includes(state.screen)) return 17;
  if (state.screen === 'setup-checks' || state.screen === 'conflicts' || state.screen === 'export-select') return 17;
  if (['checks-running', 'deploy-running'].includes(state.screen)) return 14;
  if (isEditorScreen(state.screen)) return 13;
  return 13;
}

function isEditorScreen(screen) {
  return [
    'project-path-input', 'archive-input', 'custom-check-command', 'custom-check-name',
    'commit-message', 'commit-template', 'deploy-command', 'export-path', 'initial-commit-message',
  ].includes(screen);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
