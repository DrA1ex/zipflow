import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, appendMessage } from '../src/app/state.js';
import { buildTranscript, toggleActivityBlockAtScroll } from '../src/ui/activity.js';
import { llmActivityLines } from '../src/app/llm-progress.js';
import { finalSummaryLines } from '../src/app/run-postcheck.js';

test('readable LLM streaming preserves model line breaks and wraps long text without JSON labels', () => {
  const lines = llmActivityLines({
    provider: 'lmstudio', model: 'fixture', label: 'Receiving the model response', elapsedMs: 1200,
    chunks: 4, deliveryMode: 'chunked', batchIndex: 2, batchTotal: 3,
    reasoning: 'First reasoning line\nSecond reasoning line',
    content: 'SUMMARY:\nThis is a deliberately long readable summary sentence that must wrap within a narrow terminal pane.\nCOMMIT MESSAGE:\nImprove LLM UX',
  }, 56);
  const output = lines.join('\n');
  assert.match(output, /First reasoning line\n/);
  assert.match(output, /Second reasoning line/);
  assert.match(output, /SUMMARY:/);
  assert.match(output, /Improve LLM UX/);
  assert.doesNotMatch(output, /Structured answer/);
  assert.doesNotMatch(output, /response_format/);
  assert.ok(lines.filter((line) => line.includes('deliberately') || line.includes('terminal pane')).length >= 2);
});

test('long Activity entries, including failures, start collapsed and can be expanded at the current scroll position', () => {
  const state = createInitialState();
  appendMessage(state, 'Verbose check output', ['one', 'two', 'three', 'four', 'five'], 'error');
  let transcript = buildTranscript(state, { colors: {} }, 80);
  assert.equal(state.messages[0].collapsed, true);
  assert.match(transcript.lines.join('\n'), /▸ \[FAIL\]/);
  assert.match(transcript.lines.join('\n'), /3 more lines/);

  state.activityLayout = { ranges: transcript.ranges };
  state.transcriptScroll = transcript.ranges[0].start;
  assert.equal(toggleActivityBlockAtScroll(state), true);
  transcript = buildTranscript(state, { colors: {} }, 80);
  assert.equal(state.messages[0].collapsed, false);
  assert.match(transcript.lines.join('\n'), /▾ \[FAIL\]/);
  assert.match(transcript.lines.join('\n'), /five/);
});

test('final summary keeps the LLM result last with one compact checks and deployment line', () => {
  const state = createInitialState();
  state.plan = { counts: { created: 2, updated: 3, deleted: 1, unchanged: 7, skipped: 0, preserved: 0 } };
  state.run = {
    id: 'run-final',
    llm: { summary: ['Updated archive handling.', 'Added focused regression coverage.'] },
    checks: { passed: 5, failed: 0 },
    commit: null,
    deploy: null,
  };
  state.workflow = { deploy: { policy: 'disabled' } };
  const lines = finalSummaryLines(state);
  assert.match(lines[0], /^Summary: Updated archive handling\. · 1 more point in Activity$/);
  assert.match(lines[1], /Checks 5\/5 passed/);
  assert.match(lines[1], /Deployment/);
  assert.match(lines.at(-1), /Commit not created/);
});


test('autopilot decision streaming presents structured fields instead of raw JSON', () => {
  const lines = llmActivityLines({
    presentation: 'decision', provider: 'lmstudio', model: 'gemma',
    label: 'Receiving the model response', elapsedMs: 1_200, chunks: 4,
    content: '{"schemaVersion":1,"gate":"plan-application","action":"apply","confidence":0.91,"summary":"The plan is conflict-free.","evidence":["Checks are configured"],"risks":["One file is removed"],"conditions":["Keep deployment disabled"]}',
    reasoning: '',
  }, 80);
  const output = lines.join('\n');
  assert.match(output, /Autopilot decision/);
  assert.match(output, /Decision: Apply/);
  assert.match(output, /Confidence: High/);
  assert.match(output, /Summary: The plan is conflict-free/);
  assert.match(output, /Risks:\n\s+• One file is removed/);
  assert.doesNotMatch(output, /"schemaVersion"|"action"/);
});

test('Activity visually separates key labels and mutes the collapsed expansion hint', () => {
  const state = createInitialState();
  appendMessage(state, 'Review coverage', [
    'Delivery: Representative sample',
    'Reviewed content: 3 of 20 changed files',
    'Patch coverage: 42%',
    'Condition: Deployment remains disabled',
    'Extra detail',
  ], 'info');
  const theme = { accent: '\\x1b[35m', textMuted: '\\x1b[2m', title: '\\x1b[1m' };
  const output = buildTranscript(state, theme, 90).lines.join('\n');
  assert.match(output, /\\x1b\[35mDelivery:/);
  assert.match(output, /\\x1b\[2m… 3 more lines · click or press E to expand/);
});
