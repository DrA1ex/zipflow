import { color, wrapText } from 'terlio.js';
import { llmActivityLines } from '../app/llm-progress.js';

export function transcriptLines(state, theme, width) {
  return buildTranscript(state, theme, width).lines;
}

export function buildTranscript(state, theme, width) {
  const lines = [];
  const ranges = [];
  if (!state.messages.length && !state.llmRuntime) return { lines: ['Starting Zipflow…'], ranges };
  for (const message of state.messages) {
    const start = lines.length;
    if (message.tone === 'project') lines.push(...projectActivityBlock(message, theme, width));
    else lines.push(...standardActivityMessage(message, theme, width));
    const end = Math.max(start, lines.length - 1);
    ranges.push({ messageId: message.id, start, end, collapsible: message.collapsible, collapsed: message.collapsed });
    lines.push('');
  }
  if (state.llmRuntime) lines.push(...llmActivityLines(state.llmRuntime, width));
  return { lines, ranges };
}

export function toggleActivityBlockAtScroll(state) {
  const layout = state.activityLayout;
  if (!layout?.ranges?.length) return false;
  const scroll = Number(state.transcriptScroll) || 0;
  const range = layout.ranges.find((item) => item.collapsible && item.start <= scroll && item.end >= scroll)
    ?? layout.ranges.find((item) => item.collapsible && item.start >= scroll)
    ?? [...layout.ranges].reverse().find((item) => item.collapsible && item.end <= scroll);
  if (!range) return false;
  const message = state.messages.find((item) => item.id === range.messageId);
  if (!message) return false;
  message.collapsed = !message.collapsed;
  state.transcriptSticky = false;
  return true;
}

function standardActivityMessage(message, theme, width) {
  const token = message.tone === 'error' ? 'danger'
    : message.tone === 'success' ? 'success'
      : message.tone === 'warning' ? 'warning'
        : message.tone === 'choice' ? 'accent' : 'title';
  const marker = message.collapsible ? (message.collapsed ? '▸ ' : '▾ ') : '';
  const body = message.collapsible && message.collapsed
    ? collapsedLines(message.lines)
    : message.lines ?? [];
  const bodyWidth = Math.max(20, width - 7);
  return [
    color(theme, token, `${marker}${activityTag(message.tone)} ${message.title}`),
    ...body.flatMap((line) => formatActivityBodyLine(message, line, theme, bodyWidth)),
  ];
}

function formatActivityBodyLine(message, line, theme, width) {
  const value = String(line ?? '');
  const wrapped = wrapText(value, width, '  ');
  if (message.tone !== 'diff') return wrapped.map((part) => `  ${part}`);
  const token = diffToken(value);
  return wrapped.map((part) => `  ${token ? color(theme, token, part) : part}`);
}

function diffToken(line) {
  if (line.startsWith('@@') || line.startsWith('diff --git ')) return 'accent';
  if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) return 'textMuted';
  if (line.startsWith('+')) return 'success';
  if (line.startsWith('-')) return 'danger';
  return null;
}

function collapsedLines(lines = []) {
  const visible = lines.slice(0, 2);
  const hidden = Math.max(0, lines.length - visible.length);
  return hidden ? [...visible, `… ${hidden} more lines · scroll here and press E to expand`] : visible;
}

function projectActivityBlock(message, theme, width) {
  const innerWidth = Math.max(24, width - 7);
  const title = ` ${message.title} `;
  const top = `╭─${title}${'─'.repeat(Math.max(0, innerWidth - title.length - 1))}╮`;
  const bottom = `╰${'─'.repeat(innerWidth)}╯`;
  const content = (message.lines ?? []).flatMap((line) => wrapText(String(line ?? ''), innerWidth - 2));
  return [
    color(theme, 'accent', top),
    ...content.map((line) => `${color(theme, 'accent', '│')} ${line.padEnd(innerWidth - 1)}${color(theme, 'accent', '│')}`),
    color(theme, 'accent', bottom),
  ];
}

function activityTag(tone) {
  if (tone === 'success') return '[DONE]';
  if (tone === 'warning') return '[WARN]';
  if (tone === 'error') return '[FAIL]';
  if (tone === 'choice') return '[YOU ]';
  if (tone === 'process') return '[RUN ]';
  if (tone === 'summary') return '[SUM ]';
  return '[INFO]';
}
