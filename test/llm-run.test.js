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
        choices: [{ message: { content: JSON.stringify({
          summary: ['Обновлена логика значения.', 'Добавлен новый модуль.'],
          commitMessage: 'Обновить значение и добавить модуль',
        }) } }],
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
      llmLanguage: 'Russian',
    };
    const controller = new ZipflowController(state);

    beginArchiveInput(controller);
    state.editor.insert(archive);
    await submitRunEditor(controller);

    assert.equal(state.screen, 'plan-review');
    assert.deepEqual(state.run.llm.summary, ['Обновлена логика значения.', 'Добавлен новый модуль.']);
    assert.equal(state.run.llm.commitMessage, 'Обновить значение и добавить модуль');
    assert.ok(state.messages.some((message) => message.title === 'Local LLM summary'
      && message.lines.includes('Добавлен новый модуль.')));
    assert.match(requestBody.messages[0].content, /Write both summary and commitMessage in Russian/);
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
