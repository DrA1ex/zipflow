export function parseRichTextBlocks(value) {
  const text = normalizeText(value);
  const standalone = standaloneCode(text);
  if (standalone) return [{ type: 'code', ...standalone }];
  const lines = text.split('\n');
  const blocks = [];
  let textLines = [];
  let codeLines = null;
  let language = '';
  const flushText = () => {
    if (!textLines.length) return;
    blocks.push({ type: 'text', lines: textLines });
    textLines = [];
  };
  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([A-Za-z0-9_+.-]*)\s*$/);
    if (fence) {
      if (codeLines === null) {
        flushText();
        codeLines = [];
        language = normalizeLanguage(fence[1]);
      } else {
        const code = codeLines.join('\n');
        blocks.push({ type: 'code', code, language: language || inferLanguage(code) });
        codeLines = null;
        language = '';
      }
      continue;
    }
    if (codeLines === null) textLines.push(line);
    else codeLines.push(line);
  }
  if (codeLines !== null) {
    textLines.push(`\`\`\`${language}`, ...codeLines);
  }
  flushText();
  return blocks;
}

export function standaloneCode(value) {
  const text = normalizeText(value).trim();
  if (!text) return null;
  const fenced = text.match(/^```\s*([A-Za-z0-9_+.-]*)\s*\n([\s\S]*?)\n```$/);
  if (fenced) {
    const code = fenced[2];
    return { code, language: normalizeLanguage(fenced[1]) || inferLanguage(code) };
  }
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      const parsed = JSON.parse(text);
      return { code: JSON.stringify(parsed, null, 2), language: 'json' };
    } catch {
      return null;
    }
  }
  return null;
}

export function inferLanguage(value) {
  const text = String(value ?? '').trim();
  if (!text) return 'text';
  try {
    JSON.parse(text);
    return 'json';
  } catch {}
  if (/^[{\[]/.test(text) && /["'][^"']+["']\s*:/.test(text)) return 'json';
  if (/^(?:diff --git |@@ |--- |\+\+\+ )/m.test(text)) return 'diff';
  if (/^(?:#!.*\b(?:bash|sh)|\s*(?:npm|pnpm|yarn|git|cd|mkdir|rm|cp|mv)\b)/m.test(text)) return 'shell';
  if (/\b(?:const|let|var|function|import|export|async|await)\b|=>/.test(text)) return 'javascript';
  if (/\b(?:def|class|from|import|async def|elif)\b.*:|^\s*#.*python/m.test(text)) return 'python';
  if (/^\s*(?:package main|func |import \()/m.test(text)) return 'go';
  if (/^\s*(?:#include|int main\s*\()/m.test(text)) return 'cpp';
  return 'text';
}

function normalizeLanguage(value) {
  const language = String(value ?? '').trim().toLowerCase();
  const aliases = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', shellscript: 'shell',
    yml: 'yaml', md: 'markdown', cxx: 'cpp', 'c++': 'cpp',
  };
  return aliases[language] ?? language;
}

function normalizeText(value) {
  return (Array.isArray(value) ? value.join('\n') : String(value ?? '')).replace(/\r\n?/g, '\n');
}
