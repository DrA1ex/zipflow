import { exists } from '../utils/fs.js';
import { hashFile, hashText } from '../utils/hash.js';
import { assertSafeProjectPath } from '../security/project-path.js';
import { currentRevision, getGitStatus } from '../git/repository.js';
import { serializeGitStatus } from './run-plan-autonomy.js';

export async function captureRunExecutionState(state) {
  const paths = [...new Set(state.run?.applied?.paths ?? [])].sort();
  const expected = planItemsByPath(state.plan);
  const files = [];
  for (const relative of paths) {
    const item = expected.get(relative) ?? null;
    const { target } = await assertSafeProjectPath(state.project.root, relative);
    const present = await exists(target);
    files.push({
      path: relative,
      kind: item?.kind ?? null,
      present,
      hash: present ? await hashFile(target) : null,
    });
  }
  const [status, revision] = await Promise.all([
    state.project.git ? getGitStatus(state.project.root).catch(() => null) : null,
    state.project.git ? currentRevision(state.project.root).catch(() => null) : null,
  ]);
  const value = {
    projectPath: state.project.root,
    workflow: {
      deployPolicy: state.workflow.deploy?.policy ?? 'disabled',
      deployCommand: state.workflow.deploy?.commandText ?? '',
      deployCwd: state.workflow.deploy?.cwd ?? '.',
      resultCommit: state.workflow.git?.resultCommit ?? 'never',
    },
    runId: state.run?.id ?? null,
    runStatus: state.run?.status ?? null,
    commitRevision: state.run?.commit?.revision ?? null,
    head: revision,
    gitStatus: serializeGitStatus(status),
    files,
  };
  return { value, hash: hashText(JSON.stringify(value)) };
}

export function runExecutionStateValidator(state, before) {
  return async () => {
    const after = await captureRunExecutionState(state);
    return { ok: before?.hash === after.hash, stateHash: after.hash, before: before?.value, after: after.value };
  };
}

function planItemsByPath(plan) {
  const result = new Map();
  for (const group of ['created', 'updated', 'deleted']) {
    for (const item of plan?.[group] ?? []) result.set(item.path, item);
  }
  return result;
}
