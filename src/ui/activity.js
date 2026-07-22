import { PropertyRows, color, renderNode, wrapText } from 'terlio.js';
import { llmActivityLines } from '../app/llm-progress.js';
import { parseRichTextBlocks } from './rich-text.js';
import { renderSyntaxLines } from './syntax-render.js';
import { translateForState as t } from '../i18n/index.js';

const transcriptCache = new WeakMap();
const messageLineCache = new WeakMap();

export function transcriptLines(state, theme, width) {
  return buildTranscript(state, theme, width).lines;
}

export function buildTranscript(state, theme, width) {
  const signature = transcriptSignature(state);
  const cached = transcriptCache.get(state);
  if (!state.llmRuntime && cached?.theme === theme && cached.width === width && cached.signature === signature) {
    return cached.result;
  }
  const lines = [];
  const ranges = [];
  if (!state.messages.length && !state.llmRuntime) return { lines: [t(state, 'Starting Zipflow…')], ranges };
  for (const message of state.messages) {
    const start = lines.length;
    lines.push(...activityMessageLines(message, theme, width, state));
    const end = Math.max(start, lines.length - 1);
    ranges.push({ messageId: message.id, start, end, collapsible: message.collapsible, collapsed: message.collapsed });
    lines.push('');
  }
  if (state.llmRuntime) lines.push(...llmActivityLines(state.llmRuntime, width, theme, {
    renderCode: (code, language, options = {}) => renderSyntaxLines(code, language, { ...options, theme }),
  }));
  const result = { lines, ranges };
  if (!state.llmRuntime) transcriptCache.set(state, { theme, width, signature, result });
  return result;
}

function activityMessageLines(message, theme, width, state) {
  const cached = messageLineCache.get(message);
  const language = state?.i18n?.languageId ?? state?.settings?.interfaceLanguage ?? 'en';
  if (cached?.theme === theme && cached.width === width && cached.language === language && cached.at === message.at
    && cached.collapsed === message.collapsed && cached.linesRef === message.lines
    && cached.title === message.title && cached.tone === message.tone
    && cached.collapsedSummary === message.collapsedSummary && cached.collapsible === message.collapsible) return cached.result;
  const result = message.tone === 'project'
    ? projectActivityBlock(message, theme, width, state)
    : standardActivityMessage(message, theme, width, state);
  messageLineCache.set(message, {
    theme, width, language, at: message.at, collapsed: message.collapsed, linesRef: message.lines,
    title: message.title, tone: message.tone, collapsedSummary: message.collapsedSummary,
    collapsible: message.collapsible, result,
  });
  return result;
}

function transcriptSignature(state) {
  return state.messages.map((message) => [
    message.id, message.at, message.collapsed ? 1 : 0, message.lines?.length ?? 0,
  ].join(':')).join('|');
}

export function toggleActivityBlockAtScroll(state) {
  const layout = state.activityLayout;
  if (!layout?.ranges?.length) return false;
  const scroll = Number(state.transcriptScroll) || 0;
  const range = layout.ranges.find((item) => item.collapsible && item.start <= scroll && item.end >= scroll)
    ?? layout.ranges.find((item) => item.collapsible && item.start >= scroll)
    ?? [...layout.ranges].reverse().find((item) => item.collapsible && item.end <= scroll);
  return toggleRange(state, range);
}

export function toggleActivityBlockAtRow(state, row) {
  const range = state.activityLayout?.ranges?.find((item) => (
    item.collapsible && item.start <= row && item.end >= row
  ));
  return toggleRange(state, range);
}

function toggleRange(state, range) {
  if (!range) return false;
  const message = state.messages.find((item) => item.id === range.messageId);
  if (!message) return false;
  message.collapsed = !message.collapsed;
  state.transcriptSticky = false;
  return true;
}

function standardActivityMessage(message, theme, width, state) {
  const token = message.tone === 'error' ? 'danger'
    : message.tone === 'success' ? 'success'
      : message.tone === 'warning' ? 'warning'
        : ['choice', 'autopilot', 'run'].includes(message.tone) ? 'accent' : 'title';
  const marker = message.collapsible ? (message.collapsed ? '▸ ' : '▾ ') : '';
  const body = message.collapsible && message.collapsed
    ? collapsedLines(message, state)
    : (message.lines ?? []).map((line) => t(state, line));
  const bodyWidth = Math.max(20, width - 7);
  return [
    color(theme, token, `${marker}${activityTag(message.tone)} ${t(state, message.title)}`),
    ...formatRichActivityBody(message, body, theme, bodyWidth),
  ];
}

function formatRichActivityBody(message, body, theme, width) {
  return parseRichTextBlocks(body).flatMap((block) => block.type === 'code'
    ? renderSyntaxLines(block.code, block.language, { width: width + 2, theme, indent: 2 })
    : block.lines.flatMap((line) => formatActivityBodyLine(message, line, theme, width)));
}

function formatActivityBodyLine(message, line, theme, width) {
  const value = String(line ?? '');
  const wrapped = wrapText(value, width, '  ');
  if (message.tone === 'diff') {
    const token = diffToken(value);
    return wrapped.map((part) => `  ${token ? color(theme, token, part) : part}`);
  }
  if (isExpansionHint(value)) return wrapped.map((part) => `  ${color(theme, 'textMuted', part)}`);
  return wrapped.map((part, index) => `  ${formatKeyValue(part, index === 0, theme)}`);
}

function formatKeyValue(value, firstLine, theme) {
  if (!firstLine) return value;
  const match = String(value).match(/^([A-Za-z][A-Za-z0-9 /_-]{0,42}:)(\s*)(.*)$/);
  if (!match) return value;
  return `${color(theme, 'accent', match[1])}${match[2]}${match[3]}`;
}

function isExpansionHint(value) {
  return /click or press E to expand$/i.test(String(value ?? ''));
}

function diffToken(line) {
  if (line.startsWith('@@') || line.startsWith('diff --git ')) return 'accent';
  if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) return 'textMuted';
  if (line.startsWith('+')) return 'success';
  if (line.startsWith('-')) return 'danger';
  return null;
}

function collapsedLines(message, state) {
  const lines = message.lines ?? [];
  if (message.collapsedSummary) return [t(state, message.collapsedSummary), t(state, `… ${lines.length} detail lines · click or press E to expand`)];
  const visible = lines.slice(0, 2);
  const hidden = Math.max(0, lines.length - visible.length);
  const localized = visible.map((line) => t(state, line));
  return hidden ? [...localized, t(state, `… ${hidden} more lines · click or press E to expand`)] : localized;
}

function projectActivityBlock(message, theme, width, state) {
  const rows = (message.lines ?? []).map((line) => splitProjectProperty(t(state, line)));
  const highlightedTheme = {
    ...theme,
    borderMuted: theme?.borderActive ?? theme?.textAccent ?? theme?.border,
  };
  return renderNode(PropertyRows({ title: ` ${t(state, message.title)} `, rows, theme: highlightedTheme }), Math.max(24, width - 4));
}

function splitProjectProperty(line) {
  const value = String(line ?? '');
  const separator = value.indexOf(':');
  if (separator < 0) return ['', value];
  return [value.slice(0, separator + 1), value.slice(separator + 1).trimStart()];
}

function activityTag(tone) {
  if (tone === 'success') return '[DONE]';
  if (tone === 'warning') return '[WARN]';
  if (tone === 'error') return '[FAIL]';
  if (tone === 'choice') return '[YOU ]';
  if (tone === 'autopilot') return '[AUTO]';
  if (tone === 'run') return '[RUN ]';
  if (tone === 'process') return '[RUN ]';
  if (tone === 'summary') return '[SUM ]';
  return '[INFO]';
}
