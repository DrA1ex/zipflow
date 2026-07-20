import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { exists } from '../../utils/fs.js';

export async function detectSwiftProject(root) {
  const packageFile = await exists(path.join(root, 'Package.swift'));
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const workspace = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.xcworkspace'))?.name ?? null;
  const project = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'))?.name ?? null;
  if (!packageFile && !workspace && !project) return null;
  const checks = [];
  if (packageFile) {
    checks.push(commandCheck('swift-test', 'Swift tests', ['swift', 'test'], 'test', true, 1_800_000));
    checks.push(commandCheck('swift-build', 'Swift build', ['swift', 'build'], 'build', false, 1_800_000));
  }
  const container = workspace ?? project;
  if (container) {
    const scheme = path.basename(container, path.extname(container));
    const selector = workspace ? ['-workspace', workspace] : ['-project', project];
    checks.push(commandCheck(
      'xcode-test', 'Xcode macOS tests', ['xcodebuild', ...selector, '-scheme', scheme, '-destination', 'platform=macOS', 'test'],
      'test', !packageFile, 2_700_000,
    ));
    checks.push(commandCheck(
      'xcode-build', 'Xcode macOS build', ['xcodebuild', ...selector, '-scheme', scheme, '-destination', 'platform=macOS', 'build'],
      'build', false, 2_700_000,
    ));
  }
  return {
    id: 'swift',
    label: container ? 'Swift · macOS' : 'Swift Package',
    details: { packageFile, workspace, project, scheme: container ? path.basename(container, path.extname(container)) : null },
    files: ['Package.swift', workspace, project].filter(Boolean),
    checks,
    note: container ? 'The detected Xcode scheme is inferred from the project or workspace name and can be adjusted in workflow checks.' : null,
  };
}

function commandCheck(id, name, command, type, selected, timeoutMs) {
  return { id, name, description: command.join(' '), kind: 'command', type, command, selected, required: true, timeoutMs };
}
