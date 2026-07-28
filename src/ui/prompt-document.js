import {
  color,
  createTextLineSource,
  highlightSyntaxLines,
  renderBlockLines,
  visibleLength,
  wrapText,
} from 'terlio.js';
import { inferLanguage, parseRichTextBlocks } from './rich-text.js';

const HIGHLIGHT_CHUNK_LINES = 128;

export function createPromptDocumentSource(prompt, { width = 80, theme = null } = {}) {
  const builder = new PromptDocumentBuilder({ width, theme });
  if (prompt?.requests?.length) {
    for (const [index, request] of prompt.requests.entries()) {
      builder.static(`REQUEST ${index + 1} · ${request.label || 'LLM prompt'}`, 'accent');
      builder.static(`${request.provider || 'LLM'} · ${request.model || '(unknown model)'} · ${request.structured ? 'structured output' : 'text output'} · max ${request.maxTokens ?? '?'} tokens`, 'textMuted');
      builder.blank();
      builder.messages(request.messages);
      if (index < prompt.requests.length - 1) builder.blank();
    }
  } else {
    builder.messages(prompt?.messages);
  }
  if (!builder.length) builder.static('No prompt messages were captured.', 'textMuted');
  return builder.source();
}

export function scrollPromptDocument(view, delta) {
  if (!view) return false;
  const previous = Number(view.scroll) || 0;
  const next = Math.max(0, Math.min(previous + (Number(delta) || 0), Number(view.maxScroll) || 0));
  view.scroll = next;
  return next !== previous;
}

class PromptDocumentBuilder {
  constructor({ width, theme }) {
    this.width = Math.max(16, Number(width) || 80);
    this.theme = theme;
    this.rows = [];
    this.chunks = [];
    this.renderedChunks = 0;
    this.renderedLines = 0;
  }

  get length() {
    return this.rows.length;
  }

  blank() {
    this.rows.push({ kind: 'static', value: '' });
  }

  static(value, token = 'text', indent = 0) {
    const text = String(value ?? '');
    const prefix = ' '.repeat(Math.max(0, indent));
    const available = Math.max(8, this.width - indent);
    const parts = visibleLength(text) > available ? wrapText(text, available) : [text];
    for (const part of parts.length ? parts : ['']) this.rows.push({ kind: 'static', value: `${prefix}${part}`, token });
  }

  messages(messages) {
    for (const message of messages ?? []) {
      this.static(String(message?.role || 'user').toUpperCase(), 'accent');
      this.content(String(message?.content ?? ''), 2);
      this.blank();
    }
  }

  content(content, indent) {
    const blocks = parseRichTextBlocks(content);
    for (const block of blocks) {
      if (block.type === 'code') {
        const language = block.language || inferLanguage(block.code);
        if (language === 'diff' || looksLikeDiff(block.code)) this.diff(block.code, indent);
        else this.code(block.code, language, indent);
        continue;
      }
      this.textLines(block.lines ?? [], indent);
    }
  }

  textLines(lines, indent) {
    let index = 0;
    while (index < lines.length) {
      if (startsDiff(lines, index)) {
        const end = diffRunEnd(lines, index);
        this.diff(lines.slice(index, end).join('\n'), indent);
        index = end;
        continue;
      }
      this.static(lines[index], 'text', indent);
      index += 1;
    }
  }

  code(source, language, indent) {
    const lines = normalizedLines(source);
    this.static(`CODE · ${String(language || 'text').toUpperCase()}`, 'accent', indent);
    for (let start = 0; start < lines.length; start += HIGHLIGHT_CHUNK_LINES) {
      const chunkLines = lines.slice(start, start + HIGHLIGHT_CHUNK_LINES);
      const chunk = this.chunk({ type: 'code', lines: chunkLines, language, indent });
      for (let offset = 0; offset < chunkLines.length; offset += 1) this.rows.push({ kind: 'chunk', chunk, offset });
    }
  }

  diff(source, indent) {
    const lines = normalizedLines(source);
    for (let start = 0; start < lines.length; start += HIGHLIGHT_CHUNK_LINES) {
      const chunkLines = lines.slice(start, start + HIGHLIGHT_CHUNK_LINES);
      const first = start + 1;
      const last = start + chunkLines.length;
      const title = lines.length > HIGHLIGHT_CHUNK_LINES ? `diff · lines ${first}–${last}` : 'diff';
      const chunk = this.chunk({ type: 'diff', lines: chunkLines, title, indent });
      for (let offset = 0; offset < chunkLines.length + 2; offset += 1) this.rows.push({ kind: 'chunk', chunk, offset });
    }
  }

  chunk(options) {
    const chunk = new LazyHighlightChunk({ ...options, width: this.width, theme: this.theme, onRender: (lineCount) => {
      this.renderedChunks += 1;
      this.renderedLines += lineCount;
    } });
    this.chunks.push(chunk);
    return chunk;
  }

  source() {
    const source = createTextLineSource({
      length: this.rows.length,
      getLine: (index) => this.line(index),
    });
    source.getDiagnostics = () => ({
      rows: this.rows.length,
      chunks: this.chunks.length,
      renderedChunks: this.renderedChunks,
      renderedLines: this.renderedLines,
      chunkLines: HIGHLIGHT_CHUNK_LINES,
    });
    return source;
  }

  line(index) {
    const row = this.rows[index];
    if (!row) return '';
    if (row.kind === 'chunk') return row.chunk.line(row.offset);
    return row.token ? paint(this.theme, row.token, row.value) : row.value;
  }
}

class LazyHighlightChunk {
  constructor({ type, lines, language = 'text', title = '', indent = 0, width, theme, onRender }) {
    this.type = type;
    this.lines = lines;
    this.language = language;
    this.title = title;
    this.indent = Math.max(0, indent);
    this.width = Math.max(8, width - this.indent);
    this.theme = theme;
    this.onRender = onRender;
    this.rendered = null;
  }

  line(index) {
    if (!this.rendered) this.render();
    return this.rendered[index] ?? '';
  }

  render() {
    const prefix = ' '.repeat(this.indent);
    if (this.type === 'diff') {
      this.rendered = renderBlockLines({
        block: { type: 'diff', title: this.title, content: this.lines.join('\n') },
        width: this.width,
        theme: this.theme,
      }).map((line, index) => {
        const sourceLine = index > 0 && index <= this.lines.length ? this.lines[index - 1] : '';
        const token = promptDiffToken(sourceLine);
        const renderedLine = token ? paint(this.theme, token, line) : line;
        return `${prefix}${renderedLine}`;
      });
    } else {
      this.rendered = highlightSyntaxLines(this.lines.join('\n'), {
        language: this.language,
        theme: this.theme,
        enabled: true,
      }).map((line) => `${prefix}${line}`);
    }
    this.onRender?.(this.lines.length);
  }
}

function normalizedLines(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function looksLikeDiff(value) {
  return /^(?:diff --git |@@ |--- |\+\+\+ )/m.test(String(value ?? ''));
}

function startsDiff(lines, index) {
  const line = String(lines[index] ?? '');
  if (line.startsWith('diff --git ')) return true;
  return line.startsWith('--- ') && String(lines[index + 1] ?? '').startsWith('+++ ');
}

function diffRunEnd(lines, start) {
  let index = start + 1;
  for (; index < lines.length; index += 1) {
    const line = String(lines[index] ?? '');
    if (line.startsWith('diff --git ')) continue;
    if (/^(?:index |@@ |--- |\+\+\+ |[+\- ]|\\ No newline at end of file)/.test(line) || line === '') continue;
    break;
  }
  return index;
}

function promptDiffToken(line) {
  const value = String(line ?? '');
  if (value.startsWith('+') && !value.startsWith('+++')) return 'success';
  if (value.startsWith('-') && !value.startsWith('---')) return 'danger';
  return null;
}

function paint(theme, token, value) {
  return theme ? color(theme, token, String(value ?? '')) : String(value ?? '');
}
