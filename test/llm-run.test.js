import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createInitialState } from '../src/app/state.js';
import { ZipflowController } from '../src/app/controller.js';
import { beginArchiveInput, submitRunEditor } from '../src/app/run-flow.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { discoverProject } from '../src/project/detect.js';
import { DEFAULT_SETTINGS } from '../src/settings/store.js';
import { createZip, initGit, tempDir, writeFiles } from '../test-support/helpers.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

test('archive inspection persists changes.patch and records the local LLM result in Activity', async () => {
  const home = await tempDir('zipflow-llm-run-home-');
  const root = await tempDir('zipflow-llm-run-project-');
  const archive = path.join(await tempDir('zipflow-llm-run-archive-'), 'update.zip');
  const originalFetch = globalThis.fetch;
  process.env.ZIPFLOW_HOME = home;
  try {
    await writeFiles(root, {
      'package.json': '{"name":"fixture"}\n',
      'src/index.js': 'export const value = 1;\n',
    });
    await initGit(root);
    await createZip(archive, {
      'package.json': '{"name":"fixture"}\n',
      'src/index.js': 'export const value = 2;\n',
      'src/new.js': 'export const added = true;\n',
    });

    let requestBody = null;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        choices: [{ message: { content: [
          'SUMMARY:',
          '- Обновлена логика значения.',
          '- Добавлен новый модуль.',
          'COMMIT MESSAGE:',
          'Обновить значение и добавить модуль',
          'ASSESSMENT:',
          'suitable',
          'CONFIDENCE:',
          'high',
          'REASONS:',
          '- [list in Russian]',
          '- Reviewing the trees:',
          '- I need to check whether the project is compatible.',
          '- Структура и маркеры проекта совпадают.',
        ].join('\n') } }],
      });
    };

    const project = await discoverProject(root);
    const workflow = createRecommendedWorkflow(project);
    workflow.checks = [];
    workflow.policy.confirmPlan = true;
    workflow.git.resultCommit = 'never';
    const state = createInitialState();
    state.project = project;
    state.workflow = workflow;
    state.settings = {
      ...DEFAULT_SETTINGS,
      llmProvider: 'ollama',
      llmModel: 'qwen-coder',
      llmPromptLanguage: 'English',
      llmSummaryLanguage: 'Russian',
      llmCommitLanguage: 'Russian',
      llmArchiveReview: 'patch',
    };
    const controller = new ZipflowController(state);

    beginArchiveInput(controller);
    state.editor.insert(archive);
    await submitRunEditor(controller);

    assert.equal(state.screen, 'plan-review');
    assert.equal(state.run.llm, null, 'the deterministic plan should be visible before the LLM finishes');
    assert.equal(state.llmReviewPending, true);
    const llmReview = state.llmReviewPromise;
    assert.ok(llmReview);
    await llmReview;
    assert.deepEqual(state.run.llm.summary, ['Обновлена логика значения.', 'Добавлен новый модуль.']);
    assert.equal(state.run.llm.commitMessage, 'Обновить значение и добавить модуль');
    const summaryMessage = state.messages.find((message) => message.title === 'Local LLM summary');
    assert.ok(summaryMessage, 'the LLM summary should be visible before commit selection');
    assert.deepEqual(summaryMessage.lines, ['Обновлена логика значения.', 'Добавлен новый модуль.']);
    assert.equal(summaryMessage.tone, 'summary');
    const suitability = state.messages.find((message) => message.title === 'Local LLM archive suitability');
    assert.ok(suitability);
    assert.match(suitability.lines.join(' '), /Suitable/i);
    assert.match(suitability.lines.join(' '), /Confidence: High/i);
    const suitabilityText = suitability.lines.join(' ');
    assert.match(suitabilityText, /Reasons:/);
    assert.match(suitabilityText, /Структура и маркеры проекта совпадают/);
    assert.doesNotMatch(suitabilityText, /list in Russian|Reviewing the trees|I need to check/);
    assert.doesNotMatch(suitabilityText, /Reason:/);
    assert.match(requestBody.messages[0].content, /Write summary and reasons in Russian[\s\S]*Write commitMessage in Russian/);
    assert.equal('response_format' in requestBody, false, 'visible generation must stream readable text instead of JSON');
    assert.match(requestBody.messages[1].content, /src\/index\.js/);

    const patch = await readFile(state.run.patch.path, 'utf8');
    assert.match(patch, /diff --git a\/src\/index\.js b\/src\/index\.js/);
    assert.match(patch, /-export const value = 1;/);
    assert.match(patch, /\+export const value = 2;/);
    assert.match(patch, /diff --git a\/src\/new\.js b\/src\/new\.js/);
    await controller.cleanup();
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ZIPFLOW_HOME;
  }
});

test('Escape cancels local LLM generation and still presents the update plan', async () => {
  const home = await tempDir('zipflow-llm-cancel-home-');
  const root = await tempDir('zipflow-llm-cancel-project-');
  const archive = path.join(await tempDir('zipflow-llm-cancel-archive-'), 'update.zip');
  const originalFetch = globalThis.fetch;
  process.env.ZIPFLOW_HOME = home;
  try {
    await writeFiles(root, {
      'package.json': '{"name":"fixture"}\n',
      'src/index.js': 'export const value = 1;\n',
    });
    await initGit(root);
    await createZip(archive, {
      'package.json': '{"name":"fixture"}\n',
      'src/index.js': 'export const value = 2;\n',
    });

    globalThis.fetch = async (url, options = {}) => {
      if (url.endsWith('/api/v1/models')) return jsonResponse({
        models: [{
          type: 'llm', key: 'gemma', max_context_length: 32_000,
          loaded_instances: [{ id: 'gemma-loaded', config: { context_length: 16_000 } }],
          capabilities: { reasoning: { allowed_options: ['off'], default: 'off' } },
        }],
      });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    };

    const project = await discoverProject(root);
    const workflow = createRecommendedWorkflow(project);
    workflow.checks = [];
    workflow.policy.confirmPlan = true;
    workflow.git.resultCommit = 'never';
    const state = createInitialState();
    state.project = project;
    state.workflow = workflow;
    state.settings = {
      ...DEFAULT_SETTINGS,
      llmProvider: 'lmstudio',
      llmModel: 'gemma',
      llmLanguage: 'English',
    };
    const controller = new ZipflowController(state);

    beginArchiveInput(controller);
    state.editor.insert(archive);
    const inspection = submitRunEditor(controller);
    for (let attempt = 0; attempt < 100 && !state.llmAbortController; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(state.llmAbortController, 'LLM request did not start');
    const llmReview = state.llmReviewPromise;
    await controller.handleKey({ name: 'escape' });
    await inspection;
    await llmReview;

    assert.equal(state.screen, 'plan-review');
    assert.equal(state.run.llm.cancelled, true);
    assert.ok(state.messages.some((message) => message.title === 'Local LLM generation cancelled'));
    assert.equal(state.llmAbortController, null);
    await controller.cleanup();
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ZIPFLOW_HOME;
  }
});
