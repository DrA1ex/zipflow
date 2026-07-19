import path from 'node:path';
import { exists } from '../../utils/fs.js';

const MARKERS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'poetry.lock', 'uv.lock'];

export async function detectPythonProject(root) {
  const found = [];
  for (const marker of MARKERS) if (await exists(path.join(root, marker))) found.push(marker);
  if (!found.length) return null;
  const interpreter = await detectInterpreter(root);
  const testsDetected = await exists(path.join(root, 'pytest.ini')) || await exists(path.join(root, 'tests'));
  const checks = [{
    id: 'python-syntax',
    name: 'Python syntax',
    description: `${interpreter} -m py_compile`,
    kind: 'python-syntax',
    type: 'syntax',
    interpreter,
    selected: true,
    required: true,
    timeoutMs: 180_000,
  }];
  if (testsDetected) {
    checks.push({
      id: 'python-pytest',
      name: 'Python tests',
      description: `${interpreter} -m pytest`,
      kind: 'command',
      type: 'test',
      command: [interpreter, '-m', 'pytest'],
      selected: true,
      required: true,
      timeoutMs: 900_000,
    });
  }
  return { id: 'python', label: 'Python', details: { interpreter }, files: found, checks };
}

async function detectInterpreter(root) {
  const candidates = [
    path.join(root, '.venv', 'bin', 'python'),
    path.join(root, 'venv', 'bin', 'python'),
    'python3',
    'python',
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || await exists(candidate)) return candidate;
  }
  return 'python3';
}
