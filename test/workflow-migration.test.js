import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadWorkflow, saveWorkflow } from '../src/workflow/store.js';
import { writeJsonAtomic } from '../src/utils/fs.js';
import { hashText } from '../src/utils/hash.js';
import { canonicalPath } from '../src/utils/paths.js';
import { tempDir } from '../test-support/helpers.js';

test('version 1 workflows load with deployment and archive-message defaults', async () => {
  const home = await tempDir('zipflow-workflow-home-');
  const projectPath = await tempDir('zipflow-workflow-project-');
  process.env.ZIPFLOW_HOME = home;
  try {
    await mkdir(path.join(home, 'workflows'), { recursive: true });
    const canonical = await canonicalPath(projectPath);
    const workflowPath = path.join(home, 'workflows', `${hashText(canonical).slice(0, 24)}.json`);
    await writeJsonAtomic(workflowPath, {
      version: 1,
      name: 'legacy',
      projectPath,
      projectTypes: ['node'],
      projectLabels: ['Node.js'],
      archive: { mode: 'overlay' },
      deletion: { scope: 'tracked-only' },
      exclude: ['node_modules/**', '.env', '.env.*', '.venv/**', '.DS_Store'],
      checks: [],
      policy: { id: 'practical', label: 'Practical' },
      git: { checkpoint: 'ask', resultCommit: 'ask', messageStrategy: 'generated' },
    });

    const loaded = await loadWorkflow(projectPath);
    assert.equal(loaded.version, 8);
    assert.equal(loaded.deploy.policy, 'disabled');
    assert.deepEqual(loaded.projects, [{ path: '.', typeIds: ['node'], labels: ['Node.js'], source: 'legacy', selected: true }]);
    assert.equal(loaded.autonomy.mode, 'manual');
    assert.equal(loaded.git.messageStrategy, 'generated');
    assert.ok(loaded.exclude.includes('.commit_message'));
    assert.equal(loaded.exclude.includes('.env'), true);
    assert.equal(loaded.exclude.includes('.env.*'), true);
    assert.equal(loaded.exclude.includes('.venv/**'), true);
    assert.equal(loaded.exclude.includes('.DS_Store'), true);
    assert.equal(loaded.archive.allowGitIgnoredIncomingFiles, 'no');

    const saved = await saveWorkflow(loaded);
    assert.equal(saved.version, 8);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});
