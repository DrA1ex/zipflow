import { color } from 'terlio.js';
import { llmActivityLines } from '../app/llm-progress.js';

export function transcriptLines(state, theme, width) {
  const lines = [];
  if (!state.messages.length && !state.llmRuntime) return ['Starting Zipflow…'];
  for (const message of state.messages) {
    if (message.tone === 'project') lines.push(...projectActivityBlock(message, theme, width));
    else lines.push(...standardActivityMessage(message, theme));
    lines.push('');
  }
  if (state.llmRuntime) lines.push(...llmActivityLines(state.llmRuntime));
  return lines;
}

function standardActivityMessage(message, theme) {
  const token = message.tone === 'error' ? 'danger'
    : message.tone === 'success' ? 'success'
      : message.tone === 'warning' ? 'warning'
        : message.tone === 'choice' ? 'accent' : 'title';
  return [
    color(theme, token, `${activityTag(message.tone)} ${message.title}`),
    ...(message.lines ?? []).map((line) => `  ${line}`),
  ];
}

function projectActivityBlock(message, theme, width) {
  const innerWidth = Math.max(24, width - 7);
  const title = ` ${message.title} `;
  const top = `╭─${title}${'─'.repeat(Math.max(0, innerWidth - title.length - 1))}╮`;
  const bottom = `╰${'─'.repeat(innerWidth + 1)}╯`;
  const content = (message.lines ?? []).flatMap((line) => wrapPlainLine(line, innerWidth - 2));
  return [
    color(theme, 'accent', top),
    ...content.map((line) => `${color(theme, 'accent', '│')} ${line.padEnd(innerWidth - 1)}${color(theme, 'accent', '│')}`),
    color(theme, 'accent', bottom),
  ];
}

function wrapPlainLine(value, width) {
  const text = String(value ?? '');
  if (!text) return [''];
  const lines = [];
  let remaining = text;
  while (remaining.length > width) {
    let split = remaining.lastIndexOf(' ', width);
    if (split < Math.floor(width * 0.5)) split = width;
    lines.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  lines.push(remaining);
  return lines;
}

function activityTag(tone) {
  if (tone === 'success') return '[DONE]';
  if (tone === 'warning') return '[WARN]';
  if (tone === 'error') return '[FAIL]';
  if (tone === 'choice') return '[YOU ]';
  if (tone === 'process') return '[RUN ]';
  return '[INFO]';
}
