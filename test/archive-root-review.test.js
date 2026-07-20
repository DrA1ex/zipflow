import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { extractArchive } from '../src/archive/extract.js';
import { prepareArchiveRootReview, selectArchiveRoot } from '../src/app/archive-root.js';
import { createZip, tempDir, writeFiles } from '../test-support/helpers.js';

test('Swift wrapper directory is recognized as an archive root marker', async () => {
  const root = await tempDir('zipflow-swift-wrapper-');
  const archive = path.join(root, 'VoicePanel.zip');
  await createZip(archive, {
    'VoicePanel/Package.swift': '// swift-tools-version: 6.0\n',
    'VoicePanel/Sources/VoicePanel/App.swift': 'struct App {}\n',
  });

  const extracted = await extractArchive(archive, path.join(root, 'out'));

  assert.equal(extracted.wrapperPrefix, 'VoicePanel');
  assert.equal(extracted.rootPrefix, 'VoicePanel');
  assert.deepEqual(extracted.entries.map((item) => item.relativePath), [
    'Package.swift',
    'Sources/VoicePanel/App.swift',
  ]);
});

test('suspicious single-folder archive offers root, literal subdirectory, and cancel choices', async () => {
  const root = await tempDir('zipflow-root-review-');
  await writeFiles(root, {
    'Package.swift': '// swift-tools-version: 6.0\n',
    'Sources/VoicePanel/App.swift': 'old\n',
    'Tests/VoicePanelTests/AppTests.swift': 'test\n',
  });
  const archive = path.join(root, 'update.zip');
  await createZip(archive, {
    'VoicePanel/Package.swift': '// swift-tools-version: 6.0\n',
    'VoicePanel/Sources/VoicePanel/App.swift': 'new\n',
    'VoicePanel/Tests/VoicePanelTests/AppTests.swift': 'test\n',
    'VoicePanel/Sources/VoicePanel/History.swift': 'history\n',
  });
  const extracted = await extractArchive(archive, path.join(root, 'out'));
  const review = await prepareArchiveRootReview({
    project: { root, git: false },
    workflow: {
      archive: { mode: 'snapshot' },
      deletion: { scope: 'all' },
      exclude: ['.git/**', '.zipflow/**'],
    },
    extracted,
  });

  assert.equal(review.prompt, true);
  assert.equal(review.wrapper, 'VoicePanel');
  assert.ok(review.strippedMatch >= 3);
  assert.equal(review.nestedMatch, 0);
  assert.ok(review.nestedPlan.counts.deleted >= 3);
  assert.equal(selectArchiveRoot(review, 'use-wrapper-root').extracted.rootPrefix, 'VoicePanel');
  assert.equal(selectArchiveRoot(review, 'keep-wrapper-directory').extracted.rootPrefix, null);
  assert.equal(selectArchiveRoot(review, 'cancel-root-review'), null);
});
