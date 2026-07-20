export function parseChangeResponse(content, { requireAssessment = false } = {}) {
  const source = stripFences(content);
  const json = tryJson(source);
  if (json) return normalizeObject(json, requireAssessment);
  const sections = parseSections(source);
  const summary = normalizeSummary(sections.summary);
  const commitMessage = normalizeCommitMessage(sections.commitMessage);
  if (!summary.length || !commitMessage) throw new Error('Local LLM response is missing summary or commit message.');
  const assessment = normalizeAssessment(sections);
  if (requireAssessment && !assessment) throw new Error('Local LLM response is missing archive assessment fields.');
  return { summary, commitMessage, ...(assessment ?? {}) };
}

export function parseAssessmentResponse(content) {
  const source = stripFences(content);
  const json = tryJson(source);
  if (json) return normalizeAssessment(json);
  return normalizeAssessment(parseSections(source));
}

export function extractUnstructuredResponse(content) {
  const lines = String(content ?? '').split(/\r?\n/).map(cleanLine).filter(Boolean);
  const summary = [];
  let commitMessage = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^(summary|summary \(.+\)|сводка|краткое описание)\s*:?$/i.test(line)) continue;
    if (/^(commit message|сообщение коммита)(\s*\(.+\))?\s*:?$/i.test(line)) {
      commitMessage = findCommitLine(lines.slice(index + 1));
      break;
    }
    if (/^(subject|тема)\s*:/i.test(line)) {
      commitMessage ||= line.replace(/^(subject|тема)\s*:\s*/i, '').trim();
      continue;
    }
    if (summary.length < 5 && isUsefulSummaryLine(line)) summary.push(line);
  }
  return { summary: [...new Set(summary)].slice(0, 5), commitMessage: normalizeCommitMessage(commitMessage) };
}

export function readableResponseInstructions(language, { assessment = false } = {}) {
  return [
    'Return a short plain-text response using the exact section headings below.',
    'Do not return JSON, Markdown fences, tables, or hidden reasoning.',
    'Preserve normal line breaks.',
    'SUMMARY:',
    '- one to five factual bullet points',
    'COMMIT MESSAGE:',
    'an imperative Git commit subject, optionally followed by a blank line and concise body',
    ...(assessment ? [
      'ASSESSMENT:',
      'suitable, suspicious, or unsuitable',
      'CONFIDENCE:',
      'low, medium, or high',
      'REASONS:',
      '- one to five concise reasons',
    ] : []),
    `Write both summary and commitMessage in ${language}. Write reasons in ${language}. Keep enum values in English.`,
  ].join('\n');
}

function normalizeObject(parsed, requireAssessment) {
  const summary = normalizeSummary(parsed.summary ?? parsed.changeSummary ?? parsed.change_summary);
  const commitMessage = normalizeCommitMessage(parsed.commitMessage ?? parsed.commit_message ?? parsed.commit ?? parsed.message);
  if (!summary.length || !commitMessage) throw new Error('Local LLM response is missing summary or commit message.');
  const assessment = normalizeAssessment(parsed);
  if (requireAssessment && !assessment) throw new Error('Local LLM response is missing archive assessment fields.');
  return { summary, commitMessage, ...(assessment ?? {}) };
}

function parseSections(source) {
  const result = { summary: [], commitMessage: [], reasons: [] };
  let section = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = parseSectionHeading(line.trim());
    if (heading) {
      section = heading.section;
      if (heading.value) appendSectionValue(result, section, heading.value);
      continue;
    }
    if (!section) continue;
    appendSectionValue(result, section, line);
  }
  return result;
}

function parseSectionHeading(line) {
  const patterns = [
    ['summary', /^summary\s*:\s*(.*)$/i],
    ['commitMessage', /^commit message\s*:\s*(.*)$/i],
    ['assessment', /^(?:archive )?assessment\s*:\s*(.*)$/i],
    ['confidence', /^confidence\s*:\s*(.*)$/i],
    ['reasons', /^reasons\s*:\s*(.*)$/i],
  ];
  for (const [section, pattern] of patterns) {
    const match = line.match(pattern);
    if (match) return { section, value: match[1]?.trim() ?? '' };
  }
  if (/^summary\s*$/i.test(line)) return { section: 'summary', value: '' };
  if (/^commit message\s*$/i.test(line)) return { section: 'commitMessage', value: '' };
  if (/^(archive )?assessment\s*$/i.test(line)) return { section: 'assessment', value: '' };
  if (/^confidence\s*$/i.test(line)) return { section: 'confidence', value: '' };
  if (/^reasons\s*$/i.test(line)) return { section: 'reasons', value: '' };
  return null;
}

function appendSectionValue(result, section, value) {
  const line = String(value ?? '').trimEnd();
  if (!line.trim()) return;
  if (section === 'assessment' || section === 'confidence') result[section] = line.trim();
  else result[section].push(line);
}

function normalizeAssessment(parsed) {
  const assessment = stringValue(parsed.assessment ?? parsed.verdict).toLowerCase();
  const confidence = stringValue(parsed.confidence).toLowerCase();
  const reasons = normalizeSummary(parsed.reasons);
  if (!['suitable', 'suspicious', 'unsuitable'].includes(assessment) || !reasons.length) return null;
  return {
    assessment,
    confidence: ['low', 'medium', 'high'].includes(confidence) ? confidence : 'low',
    reasons: reasons.slice(0, 5),
  };
}

function normalizeSummary(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  return values.map(cleanLine).filter(Boolean).slice(0, 5);
}

function normalizeCommitMessage(value) {
  const values = Array.isArray(value) ? value : [value];
  const result = values.map((line) => String(line ?? '').trimEnd()).join('\n').trim();
  if (!result || looksLikeJson(result)) return '';
  return result;
}

function tryJson(source) {
  try { return JSON.parse(source); } catch { /* continue */ }
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch { return null; }
}

function stripFences(content) {
  return String(content ?? '').trim().replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/, '');
}

function stringValue(value) {
  if (Array.isArray(value)) return value.find((item) => String(item ?? '').trim()) ?? '';
  return String(value ?? '').trim();
}

function cleanLine(value) {
  return String(value).trim().replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^`+|`+$/g, '').trim();
}

function findCommitLine(lines) {
  for (const line of lines) {
    if (/^(subject|тема)\s*:/i.test(line)) return line.replace(/^(subject|тема)\s*:\s*/i, '').trim();
    if (!/^(body|тело)\s*:/i.test(line) && line.length <= 200) return line;
  }
  return '';
}

function isUsefulSummaryLine(line) {
  if (line.length < 8 || line.length > 300) return false;
  if (/^(commit message|subject|body|сообщение коммита|тема|тело)\s*:?/i.test(line)) return false;
  if (/^(summary|сводка)\s*:?$/i.test(line)) return false;
  return true;
}

function looksLikeJson(value) {
  if (!/^[\[{]/.test(value)) return false;
  try { JSON.parse(value); return true; } catch { return false; }
}
