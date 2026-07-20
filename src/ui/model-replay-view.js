import {
  BottomOverlay,
  Box,
  Modal,
  OverlayHost,
  PointerRegion,
  ScrollPane,
  SelectList,
  Text,
  color,
} from 'terlio.js';

export function renderModelReplayWorkspace({ content, state, width, height, theme }) {
  const workspace = state.settingsPanel.modelTestWorkspace;
  const overlayWidth = Math.max(48, Math.min(width - 4, Math.floor(width * 0.9)));
  const overlayHeight = Math.max(12, Math.min(height - 2, Math.floor(height * 0.88)));
  const renderWorkspace = ({ width: availableWidth = overlayWidth, height: availableHeight = overlayHeight } = {}) => (
    workspace.mode === 'preview'
      ? renderReplayPreview(state, workspace, availableWidth, availableHeight, theme)
      : renderReplayProgress(state, workspace, availableWidth, availableHeight, theme)
  );
  const node = renderWorkspace({ width: overlayWidth, height: overlayHeight });
  const manager = {
    top: () => ({
      node,
      render: renderWorkspace,
      width: overlayWidth,
      shadow: true,
      opaqueRows: true,
    }),
    toasts: [],
  };
  return OverlayHost({ content, manager, theme, width, height, dim: true });
}

function renderReplayPreview(state, workspace, width, height, theme) {
  const counts = workspace.run?.plan?.counts ?? {};
  const items = [
    { id: 'start', label: 'Start replay', description: 'Run the current LLM configuration against this stored patch.' },
    { id: 'back', label: 'Back', description: 'Return to historical updates without starting a model request.' },
  ];
  const selected = items[workspace.previewIndex ?? 0];
  return Modal({
    title: ` HISTORICAL MODEL REPLAY · ${workspace.runId} `,
    children: [
      Text(color(theme, 'title', workspace.archiveName || 'Historical archive update')),
      Text(color(theme, 'textMuted', `${counts.created ?? 0} added · ${counts.updated ?? 0} changed · ${counts.deleted ?? 0} removed`)),
      Text(''),
      Text('The current model configuration, delivery strategy, review mode, and language settings will be used.', { wrap: true }),
      Text(color(theme, 'textMuted', 'No project files, Git state, backups, source archives, or run history will be changed.'), { wrap: true }),
      Text(''),
      SelectList({
        title: 'Choose', items, selectedIndex: workspace.previewIndex ?? 0,
        windowSize: 2, getLabel: (item) => item.label, getDescription: () => '',
        wrapItems: false, maxItemLines: 1, theme,
        pointerId: 'zipflow:model-replay-preview',
        onSelect: (_item, index) => state.dispatch?.({ type: 'model-replay-preview-select', index }),
      }),
      Text(color(theme, 'textMuted', selected?.description ?? ''), { wrap: true }),
    ],
    footer: '↑/↓ choose · Enter open · Esc back',
  });
}

function renderReplayProgress(state, workspace, width, height, theme) {
  const lines = replayLines(workspace, theme);
  const bodyHeight = Math.max(5, height - 8);
  const visibleRows = Math.max(1, bodyHeight - 3);
  workspace.maxScroll = Math.max(0, lines.length - visibleRows);
  workspace.scroll = clamp(workspace.scroll ?? 0, 0, workspace.maxScroll);
  if (workspace.follow !== false) {
    workspace.scroll = workspace.maxScroll;
    clearReplayUnread(workspace);
  }
  const pane = ScrollPane({
    title: ' REPLAY OUTPUT ',
    lines, width: Math.max(28, width - 4), height: bodyHeight, scroll: workspace.scroll, theme,
    footer: true,
    pointerId: 'zipflow:model-replay-workspace',
    onWheel: (event) => {
      state.dispatch?.({ type: 'model-replay-scroll', delta: Math.sign(event.deltaY) * 3 });
      event.preventDefault();
      event.stopPropagation?.();
    },
  });
  const body = workspace.unread && workspace.follow === false
    ? replayUnreadOverlay(state, workspace, pane, width, bodyHeight, theme)
    : pane;
  const statusToken = workspace.error ? 'danger'
    : workspace.running ? 'accent'
      : workspace.result ? 'success' : 'warning';
  const statusMarker = workspace.error ? '×' : workspace.running ? '●' : workspace.result ? '✓' : '○';
  const footer = workspace.running
    ? 'wheel · ↑/↓ · PgUp/PgDn · End latest · Esc cancel'
    : 'wheel · ↑/↓ · PgUp/PgDn · C result · D diagnostics · Esc close';
  return Modal({
    title: ` HISTORICAL MODEL REPLAY · ${workspace.runId} `,
    children: [
      Text(color(theme, statusToken, `${statusMarker} ${workspace.status}`), { wrap: false }),
      Text(color(theme, 'textMuted', `${workspace.archiveName || 'Historical update'} · ${(workspace.elapsedMs / 1000).toFixed(1)}s`), { wrap: false }),
      Text(''),
      body,
    ],
    footer,
  });
}

function replayUnreadOverlay(state, workspace, pane, width, height, theme) {
  const indicator = PointerRegion({
    pointerId: 'zipflow:model-replay-unread', pointerWidth: 'fill',
    onClick: (event) => {
      state.dispatch?.({ type: 'model-replay-follow-latest' });
      event.preventDefault();
      event.stopPropagation?.();
    },
  }, Box({ border: true, padding: { left: 1, right: 1 } },
    Text(color(theme, 'danger', `↓ ${workspace.unread} new replay block${workspace.unread === 1 ? '' : 's'} · click or press End`), { wrap: false }),
  ));
  return BottomOverlay({
    content: pane, overlay: indicator, height, bottom: 1, left: 2, right: 2,
    width: Math.max(28, width - 8), align: 'center', opaque: true,
  });
}

function replayLines(workspace, theme) {
  return workspace.blocks.flatMap((block) => blockLines(block, theme));
}

function blockLines(block, theme) {
  const token = block.status === 'error' ? 'danger'
    : block.status === 'active' || block.streaming ? 'accent'
      : block.status === 'done' ? 'success' : 'textMuted';
  const marker = block.status === 'error' ? '×' : block.status === 'done' ? '✓' : block.streaming || block.status === 'active' ? '●' : '○';
  return [
    color(theme, token, `${marker} ${String(block.title ?? '').toUpperCase()}`),
    ...block.lines.map((line) => `  ${color(theme, 'textMuted', line)}`),
    ...(block.reasoning ? [color(theme, 'textMuted', '  Analysis'), ...String(block.reasoning).split('\n').map((line) => `    ${color(theme, 'textMuted', line)}`)] : []),
    ...(block.content ? [color(theme, 'title', '  Model response'), ...String(block.content).split('\n').map((line) => `    ${line}`)] : []),
    '',
  ];
}

function clearReplayUnread(workspace) {
  workspace.unread = 0;
  workspace.unreadBlockIds?.clear?.();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
