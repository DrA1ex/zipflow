import path from 'node:path';
import { exists } from '../../utils/fs.js';

export async function detectCmakeProject(root) {
  if (!(await exists(path.join(root, 'CMakeLists.txt')))) return null;
  const presets = await exists(path.join(root, 'CMakePresets.json'));
  const checks = presets ? [] : [
    commandCheck('cmake-configure', 'CMake configure', ['cmake', '-S', '.', '-B', 'build'], false, 600_000),
    commandCheck('cmake-build', 'CMake build', ['cmake', '--build', 'build'], false, 1_800_000),
    commandCheck('cmake-test', 'CMake tests', ['ctest', '--test-dir', 'build', '--output-on-failure'], false, 1_800_000),
  ];
  return {
    id: 'cmake',
    label: 'CMake · C/C++',
    details: { presets },
    files: presets ? ['CMakeLists.txt', 'CMakePresets.json'] : ['CMakeLists.txt'],
    checks,
    note: presets ? 'CMake presets were found; add the preferred preset commands as custom checks.' : null,
  };
}

function commandCheck(id, name, command, selected, timeoutMs) {
  return { id, name, description: command.join(' '), kind: 'command', type: id.split('-')[1], command, selected, required: true, timeoutMs };
}
