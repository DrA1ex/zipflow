import path from 'node:path';
import { withArchiveSource } from '../archive/source.js';
import { extractArchiveFromSource } from '../archive/extract.js';
import {
  archiveRootChoices,
  prepareArchiveRootReview,
  selectArchiveRoot,
} from '../archive/root-choice.js';
import { readArchiveMetadata } from '../archive/metadata.js';
import { evaluateArchiveRisks } from '../archive/risk.js';
import { createPlanPatch } from '../patch/create.js';
import {
  createPlanDecisions,
  effectiveChangedCount,
  serializePlanSelections,
} from '../plan/selection.js';
import { getZipflowHome } from '../workflow/store.js';

export async function inspectUploadedArchive({
  runId,
  project,
  workflow,
  workflowRevision,
  blob,
  signal = null,
  onProgress = null,
  temporaryRoot = path.join(getZipflowHome(), 'tmp', runId),
} = {}) {
  validateInputs({ runId, project, workflow, workflowRevision, blob });
  return withArchiveSource(blob.path, async (source) => {
    if (source.hash !== blob.sha256 || source.size !== blob.size) {
      throw archiveRunnerError('Stored archive identity does not match its blob binding.', 'SERVER_STORAGE_CORRUPT');
    }
    onProgress?.({ phase: 'extracting', completed: 1, total: 5 });
    const extracted = await extractArchiveFromSource(source, temporaryRoot, { signal });
    onProgress?.({ phase: 'choosing_root', completed: 2, total: 5 });
    const rootReview = await prepareArchiveRootReview({ project, workflow, extracted });
    const binding = immutableBinding({
      runId,
      project,
      workflowRevision,
      blob,
      temporaryRoot,
    });
    if (rootReview.prompt) {
      return {
        outcome: 'waiting_action',
        attention: 'archive_root',
        binding,
        executable: {
          version: 1,
          binding,
          workflow: structuredClone(workflow),
          rootReview: serializableRootReview(rootReview),
          extracted: null,
          plan: null,
          decisions: [],
          metadata: null,
          safety: null,
          patch: null,
        },
        public: {
          archiveRootChoices: archiveRootChoices(rootReview),
          archiveSafety: null,
          plan: null,
          archiveInterpretation: {
            mode: workflow.archive?.mode ?? 'overlay',
            source: 'workflow',
          },
        },
      };
    }
    return completeArchivePlan({
      runId,
      project,
      workflow,
      binding,
      extracted: rootReview.extracted,
      plan: rootReview.plan,
      signal,
      onProgress,
    });
  }, { signal });
}

export async function selectArchiveRootAndPlan({
  runId,
  project,
  workflow,
  executable,
  rootId,
  signal = null,
  onProgress = null,
} = {}) {
  assertExecutableBinding(executable, { runId, project });
  const selection = selectArchiveRoot(executable.rootReview, rootId);
  if (!selection) {
    throw archiveRunnerError('The archive root choice is not available.', 'ACTION_INPUT_INVALID', 400);
  }
  return completeArchivePlan({
    runId,
    project,
    workflow,
    binding: executable.binding,
    extracted: selection.extracted,
    plan: selection.plan,
    signal,
    onProgress,
  });
}

export function executableDecisionMap(executable) {
  const decisions = new Map();
  for (const item of executable?.decisions ?? []) {
    if (typeof item?.path !== 'string') continue;
    decisions.set(item.path, item.decision ?? null);
  }
  return decisions;
}

export function updateExecutableDecision(executable, filePath, decision) {
  if (!['archive', 'keep'].includes(decision)) {
    throw archiveRunnerError('Plan decision is invalid.', 'ACTION_INPUT_INVALID', 400);
  }
  const item = executable?.decisions?.find((candidate) => candidate.path === filePath);
  if (!item) {
    throw archiveRunnerError('The requested path is not part of the run manifest.', 'ACTION_INPUT_INVALID', 400);
  }
  return {
    ...structuredClone(executable),
    decisions: executable.decisions.map((candidate) => (
      candidate.path === filePath ? { ...candidate, decision } : candidate
    )),
  };
}

export function publicPlanFromExecutable(executable) {
  if (!executable?.plan) return null;
  return publicPlan(executable.plan, executableDecisionMap(executable));
}

async function completeArchivePlan({
  runId,
  project,
  workflow,
  binding,
  extracted,
  plan,
  signal,
  onProgress,
}) {
  onProgress?.({ phase: 'metadata', completed: 3, total: 5 });
  const metadata = await readArchiveMetadata(extracted);
  const hasChanges = changedCount(plan) > 0;
  const patch = hasChanges
    ? await createPlanPatch(runId, plan, { projectPath: project.root, signal })
    : { path: null, omitted: 0 };
  onProgress?.({ phase: 'safety', completed: 4, total: 5 });
  const risk = hasChanges
    ? await evaluateArchiveRisks({
      projectPath: project.root,
      workflow,
      archiveInfo: {
        size: binding.blob.size,
        modifiedAt: binding.blob.createdAt,
      },
      extracted,
      plan,
    })
    : { warnings: [], previousRunId: null };
  const decisions = createPlanDecisions(plan);
  if (
    (workflow.autonomy?.mode ?? 'manual') === 'manual'
    && workflow.policy?.conflictPolicy === 'overwrite'
  ) {
    for (const conflict of plan.conflicts) decisions.set(conflict.path, 'archive');
  }
  const executable = {
    version: 1,
    binding,
    workflow: structuredClone(workflow),
    rootReview: null,
    extracted: serializableExtracted(extracted),
    plan: serializablePlan(plan),
    decisions: serializePlanSelections(plan, decisions),
    metadata,
    safety: {
      ...risk,
      acknowledged: risk.warnings.length === 0,
    },
    patch: patch.path ? { path: patch.path, omitted: patch.omitted } : null,
    ...manifestPlanGroups(plan),
  };
  const unresolved = unresolvedConflictCount(executable.decisions);
  const attention = !hasChanges
    ? null
    : risk.warnings.length
      ? 'archive_safety'
      : unresolved
        ? 'conflicts'
        : 'plan';
  onProgress?.({ phase: 'ready', completed: 5, total: 5 });
  return {
    outcome: hasChanges ? 'waiting_action' : 'completed',
    attention,
    binding,
    executable,
    public: {
      archiveRootChoices: [],
      archiveSafety: publicSafety(executable.safety),
      plan: publicPlan(executable.plan, decisions),
      archiveMetadata: metadata,
      archiveInterpretation: {
        mode: workflow.archive?.mode ?? 'overlay',
        source: 'workflow',
      },
    },
  };
}

function publicPlan(plan, decisions) {
  const files = ['created', 'updated', 'deleted'].flatMap((kind) => (
    (plan[kind] ?? []).map((item) => ({
      id: item.path,
      path: item.path,
      kind,
      change: kind,
      decision: decisions.get(item.path) ?? null,
    }))
  ));
  const groups = ['created', 'updated', 'deleted'].map((kind) => ({
    id: kind,
    'label': kind,
    count: plan[kind]?.length ?? 0,
  }));
  const conflicts = (plan.conflicts ?? []).map((item) => ({
    id: item.path,
    path: item.path,
    reason: item.reason,
    decision: decisions.get(item.path) ?? null,
  }));
  return {
    counts: { ...plan.counts },
    files,
    groups,
    conflicts,
    unresolvedConflicts: conflicts.filter(({ decision }) => !decision).length,
    selected: effectiveChangedCount(plan, decisions),
  };
}

function publicSafety(safety) {
  return {
    acknowledged: safety.acknowledged,
    warnings: (safety.warnings ?? []).map((warning) => ({
      code: warning.id,
      message: [warning.title, warning.detail].filter(Boolean).join(': '),
      severity: warning.severity,
    })),
  };
}

function serializableRootReview(review) {
  return {
    prompt: true,
    wrapper: review.wrapper,
    stripped: serializableExtracted(review.stripped),
    nested: serializableExtracted(review.nested),
    strippedPlan: serializablePlan(review.strippedPlan),
    nestedPlan: serializablePlan(review.nestedPlan),
    strippedMatch: review.strippedMatch,
    nestedMatch: review.nestedMatch,
  };
}

function serializableExtracted(extracted) {
  return {
    destination: extracted.destination,
    root: extracted.root,
    rootPrefix: extracted.rootPrefix,
    wrapperPrefix: extracted.wrapperPrefix,
    entries: extracted.entries.map((entry) => ({ ...entry })),
    fileCount: extracted.fileCount,
    totalSize: extracted.totalSize,
  };
}

function serializablePlan(plan) {
  return {
    ...structuredClone(plan),
    gitStatus: plan.gitStatus ? {
      entries: structuredClone(plan.gitStatus.entries ?? []),
      staged: structuredClone(plan.gitStatus.staged ?? []),
      unstaged: structuredClone(plan.gitStatus.unstaged ?? []),
      conflicted: structuredClone(plan.gitStatus.conflicted ?? []),
    } : null,
  };
}

function manifestPlanGroups(plan) {
  return Object.fromEntries(
    ['created', 'updated', 'deleted', 'preserved', 'unchanged', 'skipped', 'conflicts']
      .map((group) => [group, structuredClone(plan[group] ?? [])]),
  );
}

function immutableBinding({ runId, project, workflowRevision, blob, temporaryRoot }) {
  return {
    runId,
    projectId: project.projectId ?? null,
    projectPath: project.root,
    workflowRevision,
    blob: {
      blobId: blob.blobId,
      sha256: blob.sha256,
      size: blob.size,
      filename: blob.filename,
      createdAt: blob.createdAt,
      path: blob.path,
    },
    temporaryRoot,
  };
}

function assertExecutableBinding(executable, { runId, project }) {
  if (
    executable?.version !== 1
    || executable.binding?.runId !== runId
    || executable.binding?.projectPath !== project.root
    || !executable.rootReview?.prompt
  ) {
    throw archiveRunnerError('Archive execution manifest binding is invalid.', 'SERVER_STORAGE_CORRUPT');
  }
}

function validateInputs({ runId, project, workflow, workflowRevision, blob }) {
  if (typeof runId !== 'string' || !runId) throw new TypeError('Run ID is required.');
  if (!project?.root || !workflow?.projectPath) throw new TypeError('Project and workflow are required.');
  if (!Number.isSafeInteger(workflowRevision) || workflowRevision < 1) {
    throw new TypeError('Workflow revision is required.');
  }
  if (
    !blob?.path
    || !/^sha256:[a-f0-9]{64}$/.test(blob.blobId)
    || !/^[a-f0-9]{64}$/.test(blob.sha256)
    || !Number.isSafeInteger(blob.size)
  ) {
    throw new TypeError('A verified server blob is required.');
  }
}

function changedCount(plan) {
  return plan.created.length + plan.updated.length + plan.deleted.length;
}

function unresolvedConflictCount(decisions) {
  return decisions.filter((item) => item.decision === null).length;
}

function archiveRunnerError(message, code, status = 500) {
  return Object.assign(new Error(message), {
    code,
    status,
    expose: status < 500,
    detail: message,
  });
}
