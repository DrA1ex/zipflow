import path from 'node:path';
import { exists } from '../../utils/fs.js';

export async function detectGoProject(root) {
  if (!(await exists(path.join(root, 'go.mod'))) && !(await exists(path.join(root, 'go.work')))) return null;
  return {
    id: 'go',
    label: 'Go',
    details: {},
    files: ['go.mod', 'go.work'],
    checks: [
      check('go-format', 'Go formatting', ['gofmt', '-d'], 'go-format', true, 180_000),
      check('go-vet', 'Go vet', ['go', 'vet', './...'], 'lint', true, 600_000),
      check('go-test', 'Go tests', ['go', 'test', './...'], 'test', true, 900_000),
      check('go-build', 'Go build', ['go', 'build', './...'], 'build', false, 900_000),
    ],
  };
}

function check(id, name, command, type, selected, timeoutMs) {
  return { id, name, description: command.join(' '), kind: id === 'go-format' ? 'go-format' : 'command', type, command, selected, required: true, timeoutMs };
}
