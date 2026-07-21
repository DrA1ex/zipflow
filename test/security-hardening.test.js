import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import yazl from 'yazl';
import { extractArchive } from '../src/archive/extract.js';
import { buildUpdatePlan } from '../src/plan/build.js';
import { collectExportPaths } from '../src/export/candidates.js';
import { createRecommendedWorkflow } from '../src/workflow/defaults.js';
import { extractedFixture, initGit, tempDir, writeFiles } from '../test-support/helpers.js';

test('ZIP symbolic-link entries are rejected before extraction', async () => {
  const root = await tempDir('zipflow-symlink-zip-');
  const archive = path.join(root, 'symlink.zip');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('../../outside'), 'linked-dir', { mode: 0o120777 });
  await writeZip(zip, archive);
  await assert.rejects(extractArchive(archive, path.join(root, 'out')), /Symbolic links are not supported/);
});

test('archive paths cannot write through an existing project symlink directory', async () => {
  const root = await tempDir('zipflow-project-link-');
  const projectRoot = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  await mkdir(projectRoot); await mkdir(outside);
  await symlink(outside, path.join(projectRoot, 'linked'));
  const extracted = await extractedFixture(root, { 'linked/pwn.txt': 'owned\n' });
  const project = fixtureProject(projectRoot);
  const workflow = createRecommendedWorkflow(project);
  await assert.rejects(buildUpdatePlan({ project, workflow, extracted }), /symbolic link/);
  await assert.rejects(readFile(path.join(outside, 'pwn.txt')), /ENOENT/);
});

test('Git-tracked symbolic links are not followed during ZIP export', async () => {
  const root = await tempDir('zipflow-export-link-');
  const projectRoot = path.join(root, 'project');
  const outside = path.join(root, 'secret.txt');
  await mkdir(projectRoot);
  await writeFile(outside, 'outside secret\n');
  await symlink(outside, path.join(projectRoot, 'linked-secret.txt'));
  await writeFiles(projectRoot, { 'README.md': 'safe\n' });
  await initGit(projectRoot);
  await assert.rejects(
    collectExportPaths({ project: { ...fixtureProject(projectRoot), git: { root: projectRoot } }, mode: 'tracked' }),
    /symbolic link/,
  );
});

function fixtureProject(root) {
  return { root, name: path.basename(root), git: null, technologies: [], labels: [], checks: [], deploymentCandidates: [] };
}

function writeZip(zip, target) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(target);
    output.on('close', resolve); output.on('error', reject); zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output); zip.end();
  });
}

test('Unicode-equivalent and file-parent ZIP path collisions are rejected', async () => {
  const root = await tempDir('zipflow-collision-zip-');
  const unicodeArchive = path.join(root, 'unicode.zip');
  const unicodeZip = new yazl.ZipFile();
  unicodeZip.addBuffer(Buffer.from('a'), 'caf\u00e9.txt');
  unicodeZip.addBuffer(Buffer.from('b'), 'cafe\u0301.txt');
  await writeZip(unicodeZip, unicodeArchive);
  await assert.rejects(extractArchive(unicodeArchive, path.join(root, 'unicode-out')), /Unicode-equivalent|colliding paths/);

  const parentArchive = path.join(root, 'parent.zip');
  const parentZip = new yazl.ZipFile();
  parentZip.addBuffer(Buffer.from('file'), 'dir');
  parentZip.addBuffer(Buffer.from('child'), 'dir/child.txt');
  await writeZip(parentZip, parentArchive);
  await assert.rejects(extractArchive(parentArchive, path.join(root, 'parent-out')), /nested below a file entry/);
});

test('the selected source ZIP itself cannot be a symbolic link', async () => {
  const { inspectArchiveFile } = await import('../src/security/archive-input.js');
  const root = await tempDir('zipflow-source-link-');
  const archive = path.join(root, 'real.zip');
  const linked = path.join(root, 'linked.zip');
  await writeFile(archive, 'not parsed in this test');
  await symlink(archive, linked);
  await assert.rejects(inspectArchiveFile(linked), /symbolic link/);
});

test('apply revalidates project paths and refuses a symlink introduced after planning', async () => {
  const { rm, rename } = await import('node:fs/promises');
  const { applyUpdatePlan } = await import('../src/apply/apply.js');
  const root = await tempDir('zipflow-apply-link-race-');
  const projectRoot = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  await mkdir(projectRoot); await mkdir(outside); await mkdir(path.join(projectRoot, 'src'));
  await writeFile(path.join(projectRoot, 'src/file.txt'), 'before\n');
  const extracted = await extractedFixture(root, { 'src/file.txt': 'after\n' });
  const project = fixtureProject(projectRoot);
  const workflow = createRecommendedWorkflow(project);
  const plan = await buildUpdatePlan({ project, workflow, extracted });
  await rename(path.join(projectRoot, 'src'), path.join(projectRoot, 'src-original'));
  await symlink(outside, path.join(projectRoot, 'src'));
  await assert.rejects(applyUpdatePlan({ runId: 'security-race', projectPath: projectRoot, plan, decisions: new Map([['src/file.txt', 'archive']]) }), /symbolic link/);
  await assert.rejects(readFile(path.join(outside, 'file.txt')), /ENOENT/);
  await rm(path.join(projectRoot, 'src'), { force: true });
});

test('rollback rejects a tampered manifest that points at another project', async () => {
  const { ensureDir, writeJsonAtomic } = await import('../src/utils/fs.js');
  const { getZipflowHome } = await import('../src/workflow/store.js');
  const { saveRunRecord } = await import('../src/runs/store.js');
  const { inspectRollback } = await import('../src/apply/rollback.js');
  const home = await tempDir('zipflow-rollback-security-home-');
  const projectRoot = await tempDir('zipflow-rollback-security-project-');
  const outside = await tempDir('zipflow-rollback-security-outside-');
  process.env.ZIPFLOW_HOME = home;
  try {
    const runId = 'run-security-manifest';
    await saveRunRecord({
      version: 9, id: runId, projectPath: projectRoot, projectName: 'fixture', workflowName: 'fixture',
      status: 'applied', createdAt: new Date().toISOString(), decisions: [], autonomy: { mode: 'manual' },
    });
    const root = path.join(getZipflowHome(), 'backups', runId);
    await ensureDir(path.join(root, 'files'));
    await writeJsonAtomic(path.join(root, 'binding.json'), {
      version: 1, runId, projectPath: projectRoot, createdAt: new Date().toISOString(),
    });
    await writeJsonAtomic(path.join(root, 'manifest.json'), {
      version: 1, runId, projectPath: outside, filesRoot: path.join(root, 'files'), createdAt: new Date().toISOString(), items: [],
    });
    await assert.rejects(inspectRollback(runId), /does not match (?:its immutable binding|the stored run)/);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

test('portable ZIP validation rejects Windows device names, drive-relative paths, and alternate streams', async () => {
  const { validateZipEntry } = await import('../src/archive/security.js');
  const regular = (fileName) => ({
    fileName,
    generalPurposeBitFlag: 0,
    externalFileAttributes: 0o100644 << 16,
    uncompressedSize: 1,
    compressedSize: 1,
  });
  assert.throws(() => validateZipEntry(regular('CON.txt')), /reserved device name/);
  assert.throws(() => validateZipEntry(regular('C:relative.txt')), /absolute path|alternate-stream|drive separator/);
  assert.throws(() => validateZipEntry(regular('config.txt:secret')), /alternate-stream|drive separator/);
  assert.throws(() => validateZipEntry(regular('trailing-dot./file.txt')), /trailing character/);
});

test('ZIP export refuses to replace a symbolic-link output path', async () => {
  const { createProjectArchive } = await import('../src/export/create.js');
  const root = await tempDir('zipflow-output-link-');
  const projectRoot = path.join(root, 'project');
  const outside = path.join(root, 'outside.txt');
  const output = path.join(root, 'output.zip');
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, 'README.md'), 'safe\n');
  await writeFile(outside, 'do not replace\n');
  await symlink(outside, output);
  await assert.rejects(
    createProjectArchive({ projectRoot, paths: ['README.md'], outputPath: output }),
    /symbolic link/,
  );
  assert.equal(await readFile(outside, 'utf8'), 'do not replace\n');
});

test('backup creation never follows a project symbolic-link file', async () => {
  const { createBackup } = await import('../src/apply/backup.js');
  const home = await tempDir('zipflow-backup-link-home-');
  const root = await tempDir('zipflow-backup-link-project-');
  const outside = path.join(root, '..', 'outside-secret.txt');
  await writeFile(outside, 'outside\n');
  await symlink(outside, path.join(root, 'secret.txt'));
  process.env.ZIPFLOW_HOME = home;
  try {
    await assert.rejects(createBackup({
      runId: 'backup-link', projectPath: root,
      items: [{ kind: 'updated', path: 'secret.txt', beforeHash: 'a', afterHash: 'b' }],
    }), /symbolic link/);
  } finally {
    delete process.env.ZIPFLOW_HOME;
  }
});

test('Full autopilot cannot place protected local data into a snapshot deletion plan', async () => {
  const { autonomyForMode } = await import('../src/autonomy/policies.js');
  const fixture = await tempDir('zipflow-full-protected-delete-');
  const root = path.join(fixture, 'project');
  await mkdir(root);
  await writeFiles(root, {
    '.gitignore': 'node_modules/\n',
    '.env': 'TOKEN=secret\n',
    'credentials.json': '{"token":"secret"}\n',
    'obsolete.txt': 'remove\n',
  });
  const extracted = await extractedFixture(fixture, { 'README.md': 'new\n' });
  const project = fixtureProject(root);
  const workflow = createRecommendedWorkflow(project);
  workflow.archive.mode = 'snapshot';
  workflow.deletion.scope = 'all';
  workflow.autonomy = autonomyForMode('full');
  const plan = await buildUpdatePlan({ project, workflow, extracted });
  assert.deepEqual(plan.deleted.map((item) => item.path), ['obsolete.txt']);
  assert.equal(plan.deleted.some((item) => item.path === '.env'), false);
  assert.deepEqual(plan.preserved.map((item) => item.path), ['.gitignore', 'credentials.json']);
});
