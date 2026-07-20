import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTreeComparison, parseArchiveAssessment, reviewArchiveStructure } from '../src/llm/archive-review.js';
import { tempDir, writeFiles, extractedFixture } from '../test-support/helpers.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function nativeCompletion(content) {
  return jsonResponse({ output: [{ type: 'message', content }], stats: { input_tokens: 100, total_output_tokens: 20 } });
}

function modelCatalog() {
  return {
    models: [{
      type: 'llm', key: 'gemma', max_context_length: 32_000,
      loaded_instances: [{ id: 'gemma-loaded', config: { context_length: 16_000 } }],
      capabilities: { reasoning: { allowed_options: ['off', 'on'] } },
    }],
  };
}

test('archive assessment parser accepts fenced JSON and verdict aliases', () => {
  const parsed = parseArchiveAssessment('```json\n{"verdict":"suspicious","confidence":"medium","reasons":["Different root layout"]}\n```');
  assert.deepEqual(parsed, {
    assessment: 'suspicious', confidence: 'medium', reasons: ['Different root layout'],
  });
  assert.equal(parseArchiveAssessment('{"assessment":"suitable","reasons":[]}'), null);
});

test('tree comparison keeps ordinary dot-directories but excludes protected and configured sensitive paths', async () => {
  const root = await tempDir('zipflow-tree-project-');
  await writeFiles(root, {
    'src/index.js': 'ok', '.github/workflows/test.yml': 'name: test', '.env': 'secret', '.zipflow/state.json': '{}',
  });
  const archiveRoot = await tempDir('zipflow-tree-archive-');
  const extracted = await extractedFixture(archiveRoot, {
    'src/index.js': 'new', '.github/workflows/test.yml': 'name: changed', '.env': 'incoming', '.git/config': 'bad',
  });
  const comparison = await createTreeComparison({
    project: { root, git: false },
    workflow: { exclude: ['.env', '.env.*', '.venv/**', '.DS_Store'] },
    extracted,
  });

  assert.ok(comparison.project.entries.includes('F .github/workflows/test.yml'));
  assert.ok(comparison.archive.entries.includes('F .github/workflows/test.yml'));
  assert.equal(comparison.project.entries.some((entry) => entry.includes('.env')), false);
  assert.equal(comparison.project.entries.some((entry) => entry.includes('.zipflow')), false);
  assert.equal(comparison.archive.entries.some((entry) => entry.includes('.git/')), false);
});

test('structure guard sends project/archive trees and parses a conservative verdict', async () => {
  const root = await tempDir('zipflow-review-project-');
  await writeFiles(root, { 'package.json': '{}', 'src/index.js': 'old' });
  const extracted = await extractedFixture(await tempDir('zipflow-review-archive-'), {
    'package.json': '{}', 'src/index.js': 'new', 'test/index.test.js': 'test',
  });
  let chatBody;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/v1/models')) return jsonResponse(modelCatalog());
    chatBody = JSON.parse(options.body);
    return nativeCompletion(JSON.stringify({
      assessment: 'suitable', confidence: 'high', reasons: ['Project markers and source layout match.'],
    }));
  };
  const result = await reviewArchiveStructure({
    settings: {
      llmProvider: 'lmstudio', llmModel: 'gemma-loaded', llmLanguage: 'Russian', llmApiToken: '',
    },
    project: { root, name: 'fixture', labels: ['Node.js'], git: false },
    workflow: { exclude: ['.env', '.env.*', '.venv/**', '.DS_Store'] },
    extracted,
    plan: { counts: { created: 1, updated: 1, deleted: 0, unchanged: 1 } },
  }, { fetchImpl });

  assert.equal(result.assessment, 'suitable');
  assert.equal(result.confidence, 'high');
  assert.match(chatBody.input, /CURRENT PROJECT/);
  assert.match(chatBody.input, /ARCHIVE/);
  assert.match(chatBody.system_prompt, /Write reasons in Russian/);
  assert.equal(result.diagnostics.tree.projectFiles, 2);
  assert.equal(result.diagnostics.tree.archiveFiles, 3);
  assert.equal(path.basename(chatBody.model), 'gemma-loaded');
});

import { generateChangeDescription, parseResponse } from '../src/llm/generate.js';

test('deep patch review returns verdict, summary, and commit message from one request', async () => {
  let chatBody;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/v1/models')) return jsonResponse(modelCatalog());
    chatBody = JSON.parse(options.body);
    return nativeCompletion(JSON.stringify({
      summary: ['Updated archive validation.'],
      commitMessage: 'Improve archive validation',
      assessment: 'suspicious',
      confidence: 'medium',
      reasons: ['The patch removes several project configuration files.'],
    }));
  };
  const result = await generateChangeDescription({
    settings: {
      llmProvider: 'lmstudio', llmModel: 'gemma-loaded', llmLanguage: 'English', llmApiToken: '',
      llmArchiveReview: 'patch',
    },
    project: { name: 'fixture', labels: ['Node.js'] },
    plan: {
      counts: { created: 1, updated: 1, deleted: 2 },
      created: [{ path: 'src/new.js' }], updated: [{ path: 'src/index.js' }],
      deleted: [{ path: 'package.json' }, { path: 'package-lock.json' }],
    },
    patchContent: 'diff --git a/src/index.js b/src/index.js\n@@ -1 +1 @@\n-old\n+new\n',
  }, { fetchImpl });

  assert.equal(result.assessment, 'suspicious');
  assert.equal(result.confidence, 'medium');
  assert.equal(result.commitMessage, 'Improve archive validation');
  assert.match(chatBody.input, /DELETE package\.json/);
  assert.match(chatBody.system_prompt, /assessment suitable, suspicious, or unsuitable/);
  assert.deepEqual(parseResponse(JSON.stringify(result), { requireAssessment: true }).reasons, [
    'The patch removes several project configuration files.',
  ]);
});

test('archive assessment parser accepts inline headings returned by LM Studio', () => {
  const parsed = parseArchiveAssessment([
    'ASSESSMENT: suitable',
    'CONFIDENCE: high',
    'REASONS:',
    '* Структура проекта соответствует ожиданиям (Swift Package).',
    '* Присутствуют Sources, Tests и Package.swift.',
  ].join('\n'));

  assert.deepEqual(parsed, {
    assessment: 'suitable',
    confidence: 'high',
    reasons: [
      'Структура проекта соответствует ожиданиям (Swift Package).',
      'Присутствуют Sources, Tests и Package.swift.',
    ],
  });
});
