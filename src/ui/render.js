import {
  BottomOverlay,
  Box,
  Column,
  Modal,
  ProgressBar,
  RequireViewport,
  Row,
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
import { settingsViewModel } from '../app/settings-panel.js';
import { llmActivityLines } from '../app/llm-progress.js';
import { formatDuration, runStep } from './format.js';
import { renderDiffDocument } from '../diff/hunks.js';
import { ZIPFLOW_VERSION } from '../version.js';

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
  return Column({ height: mainHeight },
    renderTranscript(state, width, historyHeight, theme),
    renderCurrent(state, width, promptHeight, theme),
  );
}

function renderTranscript(state, width, height, theme) {
  const lines = transcriptLines(state, theme);
  const visibleRows = Math.max(1, height - 3);
  const maxScroll = Math.max(0, lines.length - visibleRows);
  if (state.transcriptSticky) state.transcriptScroll = maxScroll;
  return ScrollPane({
    title: ' Activity ',
    lines,
    width,
    height,
    scroll: state.transcriptScroll,
    footer: state.transcriptSticky ? 'following latest' : 'PgDn to return',
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
  if (state.screen === 'checks-running') return renderChecksRunning(state, height, theme);
  if (state.screen === 'deploy-running') return renderDeployRunning(state, height, theme);
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
    children: [Box({ border: true, padding: 1 }, ...lines.map((line) => Text(line, { wrap: true })))],
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
      view.scroll = scrollBy(view.scroll, event.deltaY, maxScroll);
      event.preventDefault();
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

function renderSettings(state, width, height, theme) {
  const view = settingsViewModel(state);
  const leftWidth = Math.max(24, Math.min(34, Math.floor(width * 0.3)));
  const rightWidth = Math.max(26, width - leftWidth - 2);
  const categories = WorkspacePane({
    title: ' CATEGORIES ',
    active: view.focus === 'categories' && !view.modal,
    height,
    theme,
    children: [SelectList({
      title: 'Settings',
      items: view.definitions,
      selectedIndex: view.categoryIndex,
      windowSize: Math.max(2, height - 6),
      getLabel: (item) => item.label,
      getDescription: (item) => item.description ?? '',
      wrapItems: true,
      maxItemLines: 3,
      theme,
      pointerId: 'zipflow:settings-categories',
      onSelect: (_item, index) => state.dispatch?.({ type: 'settings-select-setting', index }),
    })],
  });
  const right = renderSettingsPage(state, view, rightWidth, height, theme);
  const content = Row({ gap: 2, widths: [leftWidth, rightWidth], height }, categories, right);
  if (!view.modal) return content;
  return renderSettingsModal({ content, modal: view.modal, state, width, height, theme });
}

function renderSettingsPage(state, view, width, height, theme) {
  const choosing = view.focus === 'choices';
  const items = choosing ? view.choices : view.parameters;
  const title = choosing
    ? ` ${view.activeParameter?.label?.toUpperCase() ?? 'SELECT'} `
    : ` ${view.selectedSetting.label.toUpperCase()} `;
  const description = choosing
    ? view.activeParameter?.description ?? ''
    : view.selectedSetting.description;
  return WorkspacePane({
    title,
    active: view.focus !== 'categories' && !view.modal,
    height,
    theme,
    children: [
      Text(description, { wrap: true }),
      Text(''),
      SelectList({
        title: choosing ? 'Choose value' : 'Parameters',
        items,
        selectedIndex: choosing ? view.choiceIndex : view.parameterIndex,
        windowSize: Math.max(2, height - 8),
        getLabel: (item) => choosing ? choiceLabel(state, item) : `${item.label}: ${item.value}`,
        getDescription: (item) => item.disabled ? item.disabledReason ?? item.description ?? '' : item.description ?? '',
        getDisabled: (item) => item.disabled,
        wrapItems: true,
        maxItemLines: 3,
        theme,
        pointerId: choosing ? 'zipflow:settings-choices' : 'zipflow:settings-parameters',
        onSelect: (_item, index) => state.dispatch?.({
          type: choosing ? 'settings-select-choice' : 'settings-select-parameter',
          index,
        }),
      }),
    ],
  });
}

function choiceLabel(state, item) {
  if (!item.settingId) return item.label;
  const selected = item.selected || state.settings[item.settingId] === item.value;
  return `${selected ? '●' : '○'} ${item.label}`;
}

function renderSettingsModal({ content, modal, state, width, height, theme }) {
  const modalWidth = Math.max(40, Math.min(68, width - 10));
  const instructions = modal.field.instructions ?? [];
  const children = [
    Text(modal.field.description, { wrap: true }),
    ...instructions.map((line) => Text(color(theme, 'textMuted', line), { wrap: true })),
    modal.field.unitHint ? Text(color(theme, 'accent', modal.field.unitHint), { wrap: true }) : null,
    Text(''),
    TextEditorView({
      title: ` ${modal.field.label} `,
      value: state.editor.value,
      cursor: state.editor.cursor,
      width: Math.max(26, modalWidth - 4),
      height: 3,
      placeholder: modal.field.placeholder ?? '',
      lineNumbers: false,
    }),
    modal.error ? Text(color(theme, 'danger', modal.error), { wrap: true }) : null,
  ].filter(Boolean);
  const overlay = Modal({
    title: ` Edit ${modal.field.label} `,
    children,
    footer: 'Enter save · Esc cancel',
  });
  const estimatedHeight = Math.min(height - 2, 9 + instructions.length * 2 + (modal.field.unitHint ? 2 : 0) + (modal.error ? 2 : 0));
  return BottomOverlay({
    content,
    overlay,
    height,
    bottom: Math.max(1, Math.floor((height - estimatedHeight) / 2)),
    left: 2,
    right: 2,
    width: modalWidth,
    align: 'center',
    opaque: true,
  });
}

function transcriptLines(state, theme) {
  const lines = [];
  if (!state.messages.length && !state.llmRuntime) return ['Starting Zipflow…'];
  for (const message of state.messages) {
    const token = message.tone === 'error' ? 'danger' : message.tone === 'success' ? 'success' : message.tone === 'warning' ? 'warning' : message.tone === 'choice' ? 'accent' : 'title';
    lines.push(color(theme, token, `${activityTag(message.tone)} ${message.title}`));
    for (const line of message.lines ?? []) lines.push(`  ${line}`);
    lines.push('');
  }
  if (state.llmRuntime) lines.push(...llmActivityLines(state.llmRuntime));
  return lines;
}

function screenTitle(state) {
  const titles = {
    boot: 'Starting', home: 'Project', 'new-project': 'Project', 'setup-project': 'Project setup',
    'project-path-input': 'Choose project', 'setup-checks': 'Checks', 'custom-check-command': 'Custom check command',
    'custom-check-name': 'Custom check name', 'setup-policy': 'Update policy', 'setup-archive-mode': 'Archive mode',
    'setup-deletion-scope': 'Snapshot deletion', 'setup-git-checkpoint': 'Git checkpoint',
    'setup-git-result': 'Result commit', 'setup-git-message': 'Commit message source', 'commit-template': 'Commit template',
    'setup-deploy': 'Deployment', 'deploy-command': 'Deploy command', 'setup-review': 'Review',
    'archive-input': 'Archive', 'archive-duplicate': 'Archive already used', 'archive-safety': 'Archive safety', 'plan-review': 'Update plan', 'plan-details': 'Change groups', 'plan-files': 'Changed files', 'diff-view': 'Diff',
    'conflict-summary': 'Conflict choices', 'conflict-checkpoint': 'Conflict checkpoint', 'conflict-file': 'Resolve conflict', conflicts: 'Choose files',
    applying: 'Applying update', 'checks-running': 'Checks', 'check-failed': 'Checks failed', commit: 'Commit',
    'commit-message': 'Commit message', 'deploy-prompt': 'Deployment', 'deploy-running': 'Deployment',
    'deploy-failed': 'Deployment failed', completed: 'Completed', 'run-details': 'Last run',
    'rollback-confirm': 'Rollback', 'rolling-back': 'Rolling back',
    'export-mode': 'Create ZIP', 'export-select': 'Choose archive contents', 'export-preview': 'ZIP preview', 'export-files': 'Included files', 'export-path': 'Output archive',
    'export-running': 'Creating ZIP', 'export-complete': 'ZIP created',
    'setup-git-init': 'Initialize Git', 'setup-gitignore': 'Git ignore rules',
    'setup-initial-commit': 'First commit', 'initial-commit-message': 'First commit message',
    'run-history': 'Run history', 'run-analytics': 'Performance analytics', error: 'Error', settings: 'Settings',
  };
  return titles[state.screen] ?? 'Zipflow';
}

function footerHints(state) {
  if (state.screen === 'settings') {
    if (state.settingsPanel?.modal) return ['Enter save', 'Esc cancel', 'Tab complete path', 'Ctrl+B close settings'];
    if (state.settingsPanel?.focus === 'choices') return ['↑/↓ choose', 'Enter apply', 'Esc return to parameter', 'Ctrl+B close'];
    if (state.settingsPanel?.focus === 'parameters') return ['↑/↓ parameter', 'Enter open', 'Esc return to categories', 'Ctrl+B close'];
    return ['↑/↓ category', 'Enter open page', 'Esc or Ctrl+B close', 'Ctrl+T native select'];
  }
  if (state.screen === 'diff-view') return ['↑/↓ scroll', 'N/P next/previous hunk', 'M switch mode', 'Drag to copy', 'Esc back'];
  if (state.llmAbortController) return ['Esc cancel LLM generation', 'Ctrl+C stop'];
  if (state.busy || ['checks-running', 'deploy-running'].includes(state.screen)) return ['Ctrl+C stop'];
  if (isEditorScreen(state.screen)) return state.editorContext?.multiline
    ? ['Enter confirm', 'Ctrl+Enter newline', 'Ctrl+U clear to cursor', 'Esc back', 'Ctrl+T native select']
    : ['Enter confirm', 'Tab complete path', 'Esc back', 'Ctrl+B settings', 'Ctrl+T native select'];
  if (state.screen === 'setup-checks') return ['↑/↓ choose', 'Space toggle', 'A add', 'E edit', 'Del remove', 'Enter continue/open', 'Ctrl+B settings'];
  if (state.screen === 'conflict-file') return ['A archive', 'L local', 'D diff', 'Enter action', 'Esc back'];
  if (state.screen === 'conflicts') return ['↑/↓ choose', 'Space toggle decision', 'Enter action', 'Esc back', 'Ctrl+T native select'];
  if (state.screen === 'export-select') return ['↑/↓ choose', 'Enter/Space toggle', 'Esc back', 'Ctrl+T native select'];
  return ['↑/↓ choose', 'Enter/Space select', '? help', 'Drag Activity to copy', 'PgUp/PgDn activity', 'Ctrl+T native select', 'Ctrl+B settings'];
}

function headerStats(state) {
  const step = runStep(state);
  const stats = [
    { label: 'State', value: state.busy ? 'Working' : state.status },
    { label: 'Policy', value: state.workflow?.policy?.label ?? state.draft?.policy?.label ?? 'Not configured' },
  ];
  if (step) stats.push({ label: 'Stage', value: `${step.number}/5 ${step.label}` });
  else stats.push({ label: 'Theme', value: state.settings?.theme ?? 'ocean' });
  return stats;
}

function preferredPromptHeight(state) {
  if (state.screen === 'home') return 14;
  if (['archive-safety', 'plan-review', 'plan-details', 'plan-files', 'conflict-summary', 'conflict-file', 'run-history', 'run-analytics', 'export-preview', 'export-files'].includes(state.screen)) return 17;
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

function activityTag(tone) {
  if (tone === 'success') return '[DONE]';
  if (tone === 'warning') return '[WARN]';
  if (tone === 'error') return '[FAIL]';
  if (tone === 'choice') return '[YOU ]';
  if (tone === 'process') return '[RUN ]';
  return '[INFO]';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
