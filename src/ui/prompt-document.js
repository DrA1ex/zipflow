import { color, createTextLineSource, wrapText } from 'terlio.js';
import { inferLanguage, parseRichTextBlocks } from './rich-text.js';
import { renderSyntaxLines } from './syntax-render.js';

export function createPromptDocumentSource(prompt, { width = 80, theme = null } = {}) {
  const safeWidth = Math.max(16, Number(width) || 80);
  const rows = [];
  if (prompt?.requests?.length) {
    for (const [index, request] of prompt.requests.entries()) {
      rows.push(color(theme, 'accent', `REQUEST ${index + 1} · ${request.label || 'LLM prompt'}`));
      rows.push(color(theme, 'textMuted', `${request.provider || 'LLM'} · ${request.model || '(unknown model)'} · ${request.structured ? 'structured output' : 'text output'} · max ${request.maxTokens ?? '?'} tokens`));
      rows.push('');
      appendMessages(rows, request.messages, safeWidth, theme);
      if (index < prompt.requests.length - 1) rows.push('');
    }
  } else {
    appendMessages(rows, prompt?.messages, safeWidth, theme);
  }
  if (!rows.length) rows.push(color(theme, 'textMuted', 'No prompt messages were captured.'));
  return createTextLineSource(rows);
}

export function scrollPromptDocument(view, delta) {
  if (!view) return false;
  const previous = Number(view.scroll) || 0;
  const next = Math.max(0, Math.min(previous + (Number(delta) || 0), Number(view.maxScroll) || 0));
  view.scroll = next;
  return next !== previous;
}

function appendMessages(rows, messages, width, theme) {
  for (const message of messages ?? []) {
    rows.push(color(theme, 'accent', String(message?.role || 'user').toUpperCase()));
    appendContent(rows, String(message?.content ?? ''), width, theme, 2);
    rows.push('');
  }
}

function appendContent(rows, content, width, theme, indent) {
  const blocks = parseRichTextBlocks(content);
  for (const block of blocks) {
    if (block.type === 'code') {
      appendCode(rows, block.code, block.language || inferLanguage(block.code), width, theme, indent);
      continue;
    }
    for (const line of block.lines ?? []) appendTextLine(rows, line, width, theme, indent);
  }
}

function appendCode(rows, source, language, width, theme, indent) {
  const normalized = String(source ?? '').replace(/\r\n?/g, '\n');
  if (language === 'diff' || looksLikeDiff(normalized)) {
    for (const line of normalized.split('\n')) appendDiffLine(rows, line, width, theme, indent);
    return;
  }
  const rendered = renderSyntaxLines(normalized, language || 'text', { width: Math.max(8, width - indent), theme });
  for (const line of rendered) appendWrapped(rows, line, width, indent);
}

function appendTextLine(rows, line, width, theme, indent) {
  if (isDiffLine(line)) appendDiffLine(rows, line, width, theme, indent);
  else appendWrapped(rows, color(theme, 'text', line), width, indent);
}

function appendDiffLine(rows, line, width, theme, indent) {
  const token = diffToken(line);
  appendWrapped(rows, color(theme, token, line), width, indent);
}

function appendWrapped(rows, line, width, indent) {
  const prefix = ' '.repeat(Math.max(0, indent));
  const available = Math.max(8, width - indent);
  const wrapped = wrapText(String(line ?? ''), available);
  if (!wrapped.length) rows.push(prefix);
  else for (const part of wrapped) rows.push(`${prefix}${part}`);
}

function looksLikeDiff(value) {
  return /^(?:diff --git |@@ |--- |\+\+\+ )/m.test(String(value ?? ''));
}

function isDiffLine(value) {
  const line = String(value ?? '');
  return /^(?:diff --git |index [0-9a-f]+\.\.[0-9a-f]+|@@ |--- |\+\+\+ |[+-](?![+-])|\\ No newline at end of file)/.test(line);
}

function diffToken(value) {
  const line = String(value ?? '');
  if (line.startsWith('+') && !line.startsWith('+++')) return 'success';
  if (line.startsWith('-') && !line.startsWith('---')) return 'danger';
  if (line.startsWith('@@') || line.startsWith('diff --git ')) return 'accent';
  if (line.startsWith('+++')) return 'success';
  if (line.startsWith('---')) return 'danger';
  return 'textMuted';
}
