import * as Terlio from 'terlio.js';

const SYNTAX_EXPORTS = ['highlightSyntaxLines', 'highlightSyntax', 'SyntaxText'];

export function renderSyntaxLines(code, language = 'text', { width = 80, theme = null, indent = 0 } = {}) {
  const source = String(code ?? '').replace(/\r\n?/g, '\n');
  const available = Math.max(8, width - indent);
  const rendered = tryTerlioSyntax(source, language, { width: available, theme });
  const lines = normalizeRendered(rendered, available) ?? source.split('\n');
  const prefix = ' '.repeat(Math.max(0, indent));
  return lines.map((line) => `${prefix}${line}`);
}

export function terlioSyntaxExportName() {
  return SYNTAX_EXPORTS.find((name) => typeof Terlio[name] === 'function') ?? null;
}

function tryTerlioSyntax(code, language, { width, theme }) {
  const options = { language, width, theme };
  if (typeof Terlio.highlightSyntaxLines === 'function') {
    try {
      return Terlio.highlightSyntaxLines(code, options);
    } catch {
      // Fall through to the other documented Terlio 1.1.3 syntax surfaces.
    }
  }
  if (typeof Terlio.highlightSyntax === 'function') {
    try {
      return Terlio.highlightSyntax(code, options);
    } catch {
      // Fall through to the component form.
    }
  }
  if (typeof Terlio.SyntaxText === 'function') {
    try {
      return Terlio.SyntaxText({ code, language, width, theme, wrap: false });
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeRendered(value, width) {
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').split('\n');
  if (Array.isArray(value) && value.every((line) => typeof line === 'string')) return value;
  if (Array.isArray(value?.lines) && value.lines.every((line) => typeof line === 'string')) return value.lines;
  if (typeof value?.text === 'string') return value.text.replace(/\r\n?/g, '\n').split('\n');
  if (typeof Terlio.renderNode === 'function' && value && typeof value === 'object') {
    try {
      return Terlio.renderNode(value, width);
    } catch {
      return null;
    }
  }
  return null;
}
