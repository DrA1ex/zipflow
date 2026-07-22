import {
  Box,
  Column,
  OverlayHost,
  PointerRegion,
  ScrollPane,
  SelectList,
  Spinner,
  Text,
  color,
  renderNode,
  truncateVisible,
  visibleLength,
  wrapText,
} from 'terlio.js';
import { ContextDock } from './context-dock.js';
import { selectRowIndex, selectRows } from './select-rows.js';
import { parseRichTextBlocks } from './rich-text.js';
import { renderSyntaxLines } from './syntax-render.js';
import { translateForState as t } from '../i18n/index.js';
import { wheelScrollDelta } from './wheel.js';

export function renderModelReplayWorkspace({ content, state, width, height, theme, animationFrame = 0 }) {
  const workspace = state.settingsPanel.modelTestWorkspace;
  const overlayWidth = Math.max(48, Math.min(width - 4, Math.floor(width * 0.9)));
  const overlayHeight = Math.max(12, Math.min(height - 2, Math.floor(height * 0.88)));
  const renderWorkspace = ({ width: availableWidth = overlayWidth, height: availableHeight = overlayHeight } = {}) => (
    workspace.mode === 'preview'
      ? renderReplayPreview(state, workspace, availableWidth, availableHeight, theme)
      : renderReplayProgress(state, workspace, availableWidth, availableHeight, theme, animationFrame)
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
  const autopilot = workspace.kind === 'autopilot';
  const items = [
    { id: 'start', label: t(state, autopilot ? 'Start simulation' : 'Start replay'), description: t(state, autopilot
      ? 'Compare Guarded and Full autopilot decisions reconstructed from this historical run.'
      : 'Run the current LLM configuration against this stored patch.') },
    { id: 'back', label: t(state, 'Back'), description: t(state, 'Return to historical updates without starting a model request.') },
  ];
  const selected = items[workspace.previewIndex ?? 0];
  const rows = selectRows(items, (item) => item.label);
  return replayFrame({
    width,
    height,
    theme,
    children: [
      Text(color(theme, 'textMuted', replayIdentity(workspace)), { wrap: false }),
      Text(color(theme, 'title', workspace.archiveName || 'Historical archive update'), { wrap: false }),
      Text(color(theme, 'textMuted', `${counts.created ?? 0} added · ${counts.updated ?? 0} changed · ${counts.deleted ?? 0} removed`)),
      Text(''),
      Text(t(state, autopilot
        ? 'The current model configuration will evaluate the same decision points in Guarded and Full autopilot modes.'
        : 'The current model configuration, delivery strategy, review mode, and language settings will be used.'), { wrap: true }),
      Text(color(theme, 'textMuted', t(state, 'No project files, Git state, backups, source archives, or run history will be changed.')), { wrap: true }),
      Box({ grow: true, height: 'fill' }),
      SelectList({
        title: t(state, 'Choose'), items: rows, selectedIndex: workspace.previewIndex ?? 0,
        windowSize: 2, getLabel: (item) => item.label,
        wrapItems: false, theme,
        pointerId: 'zipflow:model-replay-preview',
        onSelect: (item, index) => state.dispatch?.({ type: 'model-replay-preview-select', index: selectRowIndex(item, index) }),
      }),
      ContextDock({ text: selected?.description ?? '', rows: 1, width: Math.max(20, width - 4), theme }),
    ],
    footer: t(state, '↑/↓ choose · Enter open · Esc back'),
    title: t(state, autopilot ? 'HISTORICAL AUTOPILOT SIMULATION' : 'HISTORICAL MODEL REPLAY'),
  });
}

function renderReplayProgress(state, workspace, width, height, theme, animationFrame) {
  const innerWidth = Math.max(20, width - 4);
  const bodyHeight = Math.max(4, height - 7);
  const lines = replayLines(workspace, theme, innerWidth);
  workspace.maxScroll = Math.max(0, lines.length - bodyHeight);
  workspace.scroll = clamp(workspace.scroll ?? 0, 0, workspace.maxScroll);
  if (workspace.follow !== false) {
    workspace.scroll = workspace.maxScroll;
    clearReplayUnread(workspace);
  }
  const pane = ScrollPane({
    lines,
    width: innerWidth,
    height: bodyHeight,
    scroll: workspace.scroll,
    border: false,
    footer: false,
    pointerId: 'zipflow:model-replay-workspace',
    onWheel: (event) => {
      state.dispatch?.({ type: 'model-replay-scroll', delta: wheelScrollDelta(event) });
      event.preventDefault();
      event.stopPropagation?.();
    },
  });
  const footer = workspace.running
    ? '↑/↓ scroll · PgUp/PgDn · End latest · Esc cancel'
    : '↑/↓ scroll · PgUp/PgDn · C copy · D diagnostics · Esc close';
  return replayFrame({
    width,
    height,
    theme,
    children: [
      Text(color(theme, 'textMuted', replayIdentity(workspace)), { wrap: false }),
      replayStatus(workspace, theme, animationFrame),
      Text(''),
      pane,
      replayUnreadIndicator(state, workspace, theme),
    ],
    footer: footerWithPosition(t(state, footer), workspace, innerWidth, theme),
    title: t(state, workspace.kind === 'autopilot' ? 'HISTORICAL AUTOPILOT SIMULATION' : 'HISTORICAL MODEL REPLAY'),
  });
}

function replayFrame({ height, theme, children, footer, title = 'HISTORICAL MODEL REPLAY' }) {
  return Box({
    border: true,
    borderColor: theme?.borderActive ?? theme?.accent ?? theme?.border,
    padding: { left: 1, right: 1 },
    height,
    title: ` ${title} `,
  }, Column({ height: Math.max(1, height - 2) }, ...children, Text(footer, { wrap: false })));
}

function replayIdentity(workspace) {
  const run = workspace.runId || 'historical run';
  const archive = workspace.archiveName || 'Historical update';
  return `${run} · ${archive}`;
}

function replayStatus(workspace, theme, animationFrame) {
  const elapsed = `${(workspace.elapsedMs / 1000).toFixed(1)}s`;
  if (workspace.running) {
    const spinner = renderNode(Spinner({ frame: animationFrame, label: workspace.status }), 120)[0].trimEnd();
    return Text(`${color(theme, 'accent', spinner)} ${color(theme, 'textMuted', `· ${elapsed}`)}`, { wrap: false });
  }
  const token = workspace.error ? 'danger' : workspace.result ? 'success' : 'warning';
  const marker = workspace.error ? '×' : workspace.result ? '✓' : '○';
  return Text(color(theme, token, `${marker} ${workspace.status} · ${elapsed}`), { wrap: false });
}

function replayUnreadIndicator(state, workspace, theme) {
  if (!workspace.unread || workspace.follow !== false) return Text('');
  return PointerRegion({
    pointerId: 'zipflow:model-replay-unread',
    pointerWidth: 'fill',
    onClick: (event) => {
      state.dispatch?.({ type: 'model-replay-follow-latest' });
      event.preventDefault();
      event.stopPropagation?.();
    },
  }, Text(color(theme, 'danger', `↓ ${workspace.unread} new replay block${workspace.unread === 1 ? '' : 's'} · click or press End`), { wrap: false }));
}

function footerWithPosition(hints, workspace, width, theme) {
  const position = `${workspace.scroll ?? 0}/${workspace.maxScroll ?? 0}`;
  const available = Math.max(1, width - visibleLength(position) - 1);
  const left = truncateVisible(hints, available, '…');
  const spacing = ' '.repeat(Math.max(1, width - visibleLength(left) - visibleLength(position)));
  return `${color(theme, 'textMuted', left)}${spacing}${color(theme, 'textMuted', position)}`;
}

function replayLines(workspace, theme, width) {
  return workspace.blocks.flatMap((block) => blockLines(block, workspace, theme, width));
}

function blockLines(block, workspace, theme, width) {
  if (block.id === 'parsed-result' && block.result) return parsedResultLines(block.result, theme, width);
  if (block.id === 'autopilot-result' && block.result) return autopilotResultLines(block.result, theme, width);
  const token = block.status === 'error' ? 'danger'
    : block.status === 'active' || block.streaming ? 'accent'
      : block.status === 'done' ? 'success' : 'textMuted';
  const marker = block.status === 'error' ? '×' : block.status === 'done' ? '✓' : block.streaming || block.status === 'active' ? '●' : '○';
  const compactCompletedOutput = Boolean(workspace.result && block.status === 'done' && (block.reasoning || block.content));
  return [
    color(theme, token, `${marker} ${String(block.title ?? '').toUpperCase()}`),
    ...block.lines.flatMap((line) => wrapColoredLine(line, width, 2, theme, 'textMuted')),
    ...(compactCompletedOutput
      ? [`  ${color(theme, 'textMuted', 'Model output parsed successfully · press D for full diagnostics')}`]
      : blockOutputLines(block, theme, width)),
    '',
  ];
}

function blockOutputLines(block, theme, width) {
  return [
    ...(block.reasoning
      ? [color(theme, 'textMuted', '  Analysis'), ...String(block.reasoning).split('\n').flatMap((line) => wrapColoredLine(line, width, 4, theme, 'textMuted'))]
      : []),
    ...(block.content
      ? [color(theme, 'accent', '  Model response'), ...richReplayLines(block.content, theme, width)]
      : []),
  ];
}

function richReplayLines(value, theme, width) {
  return parseRichTextBlocks(value).flatMap((block) => block.type === 'code'
    ? renderSyntaxLines(block.code, block.language, { width, theme, indent: 4 })
    : block.lines.flatMap((line) => wrapColoredLine(line, width, 4, theme, 'text')));
}

function autopilotResultLines(result, theme, width) {
  const lines = [color(theme, 'success', '✓ AUTOPILOT COMPARISON')];
  for (const mode of ['guarded', 'full']) {
    const current = result.modes?.[mode];
    lines.push('', color(theme, 'accent', mode.toUpperCase()),
      `  ${color(theme, 'textMuted', `${current?.automatic ?? 0} automatic · ${current?.asksUser ?? 0} ask user`)}`);
    for (const decision of current?.decisions ?? []) {
      lines.push(...wrapColoredLine(`${decision.label}: ${decision.action}`, width, 2, theme, decision.action === 'ask-user' ? 'warning' : 'text'));
      if (decision.summary) lines.push(...wrapColoredLine(decision.summary, width, 4, theme, 'textMuted'));
    }
  }
  lines.push('');
  return lines;
}

function parsedResultLines(result, theme, width) {
  const lines = [
    color(theme, 'success', '✓ PARSED RESULT'),
    '',
    color(theme, 'accent', 'SUMMARY'),
    ...(result.summary?.length
      ? result.summary.flatMap((line) => wrapBullet(line, width, theme, 'text'))
      : [`  ${color(theme, 'textMuted', 'No summary returned.')}`]),
    '',
    color(theme, 'accent', 'COMMIT MESSAGE'),
    ...(result.commitMessage
      ? wrapColoredLine(result.commitMessage, width, 2, theme, 'text')
      : [`  ${color(theme, 'textMuted', '(none)')}`]),
  ];
  if (result.assessment) {
    lines.push(
      '',
      color(theme, 'accent', 'ASSESSMENT'),
      `  ${color(theme, assessmentToken(result.assessment), `${titleCase(result.assessment)} · ${titleCase(result.confidence || 'unknown')} confidence`)}`,
    );
  }
  if (result.reasons?.length) {
    lines.push(
      '',
      color(theme, 'accent', 'REASONS'),
      ...result.reasons.flatMap((line) => wrapBullet(line, width, theme, 'text')),
    );
  }
  lines.push('');
  return lines;
}

function wrapColoredLine(value, width, indent, theme, token) {
  const prefix = ' '.repeat(indent);
  const available = Math.max(8, width - indent);
  return wrapText(String(value ?? ''), available).map((line) => `${prefix}${color(theme, token, line)}`);
}

function wrapBullet(value, width, theme, token) {
  const available = Math.max(8, width - 4);
  const rows = wrapText(String(value ?? ''), available);
  return rows.map((line, index) => `${index === 0 ? '  • ' : '    '}${color(theme, token, line)}`);
}

function assessmentToken(value) {
  return String(value).toLowerCase() === 'suitable' ? 'success' : 'warning';
}

function titleCase(value) {
  const text = String(value ?? '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function clearReplayUnread(workspace) {
  workspace.unread = 0;
  workspace.unreadBlockIds?.clear?.();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
