import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { requestFingerprint } from './store-utils.js';
import { paginateOpaque } from './opaque-pagination.js';
import {
  findManifestDiffItem,
  manifestGroupItems,
  normalizeManifestPath,
  PLAN_GROUPS,
  RUN_SESSION_STATUSES,
  runSessionError,
  validateRunSessionRecord,
} from './run-session-model.js';

export const MAX_HISTORY_PAGE_SIZE = 100;
export const MAX_PLAN_PAGE_SIZE = 100;
export const MAX_OUTPUT_PAGE_SIZE = 100;
export const MAX_OUTPUT_RESPONSE_BYTES = 64 * 1024;
export const MAX_DIFF_RESPONSE_LINES = 10_000;

const COUNT_KEYS = ['created', 'updated', 'deleted', 'preserved', 'unchanged', 'skipped', 'conflicts'];

export function projectRunResource(value) {
  const session = validateRunSessionRecord(value);
  const redact = createRedactor(session);
  return {
    runId: session.run.runId,
    kind: session.run.kind,
    seriesId: session.run.seriesId,
    operationId: session.run.operationId,
    status: session.run.status,
    revision: session.revision,
    projectId: session.binding.projectId,
    workflowRevision: session.binding.workflowRevision,
    blob: session.binding.blobId ? {
      blobId: session.binding.blobId,
      sha256: session.binding.blobSha256,
    } : null,
    correlation: projectCorrelation(session.run.correlation, redact),
    summary: projectPublicSummary(session.publicSummary, redact),
    attention: attentionForStatus(session.run.status),
    createdAt: session.run.createdAt,
    updatedAt: session.run.updatedAt,
    completedAt: session.run.completedAt,
  };
}

export function projectHistoryResource(values, {
  projectId,
  status = null,
  cursor = null,
  limit = null,
  maxLimit = MAX_HISTORY_PAGE_SIZE,
} = {}) {
  if (typeof projectId !== 'string' || !projectId) throw new TypeError('History project ID is required.');
  if (status !== null && !RUN_SESSION_STATUSES.includes(status)) {
    throw runSessionError('History status is invalid.', 'INVALID_RUN_STATUS', 400);
  }
  const sessions = values
    .map((value) => validateRunSessionRecord(value))
    .filter((session) => session.binding.projectId === projectId && (status === null || session.run.status === status))
    .sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt) || left.run.runId.localeCompare(right.run.runId));
  const resources = sessions.map(projectRunResource);
  const snapshot = requestFingerprint(resources.map(({ runId, revision }) => ({ runId, revision })));
  const result = paginateOpaque(resources, {
    resource: 'history', scope: requestFingerprint({ projectId, status }), snapshot,
    cursor, limit, maxLimit: Math.min(maxLimit, MAX_HISTORY_PAGE_SIZE),
  });
  return { projectId, status, ...result };
}

export function projectPlanResource(value, {
  group = null,
  cursor = null,
  limit = null,
  maxLimit = MAX_PLAN_PAGE_SIZE,
} = {}) {
  const session = validateRunSessionRecord(value);
  if (group !== null && !PLAN_GROUPS.includes(group)) {
    throw runSessionError('Plan group is invalid.', 'INVALID_PLAN_GROUP', 400);
  }
  const redact = createRedactor(session);
  const decisions = new Map(
    (session.executionManifest?.decisions ?? [])
      .filter(({ path } = {}) => typeof path === 'string')
      .map(({ path, decision }) => [path, decision]),
  );
  const items = manifestGroupItems(session.executionManifest, group)
    .map((item) => projectPlanItem(item, redact, decisions.get(item.path)));
  const counts = manifestCounts(session.executionManifest);
  const snapshot = requestFingerprint({ items, counts });
  const result = paginateOpaque(items, {
    resource: 'plan', scope: `${session.run.runId}:${group ?? '*'}`, snapshot,
    cursor, limit, maxLimit: Math.min(maxLimit, MAX_PLAN_PAGE_SIZE),
  });
  return {
    runId: session.run.runId,
    revision: session.revision,
    group,
    counts,
    ...result,
  };
}

export function projectOutputResource(value, {
  source,
  cursor = null,
  limit = null,
  maxLimit = MAX_OUTPUT_PAGE_SIZE,
  maxBytes = MAX_OUTPUT_RESPONSE_BYTES,
} = {}) {
  if (!['checks', 'deploy'].includes(source)) {
    throw runSessionError('Output source is invalid.', 'INVALID_OUTPUT_SOURCE', 400);
  }
  const session = validateRunSessionRecord(value);
  const redact = createRedactor(session);
  const boundedMax = normalizeOutputBytes(maxBytes);
  const requestedLimit = normalizeRequestedLimit(limit, Math.min(maxLimit, MAX_OUTPUT_PAGE_SIZE));
  const perItemBytes = Math.max(1, Math.floor(boundedMax / requestedLimit));
  const items = session.outputs
    .filter((item) => item.source === source)
    .map((item) => projectOutputItem(item, redact, perItemBytes));
  const firstSequence = items[0]?.sequence ?? 0;
  const result = paginateOpaque(items, {
    resource: 'output', scope: `${session.run.runId}:${source}`,
    snapshot: requestFingerprint({ runId: session.run.runId, source, firstSequence }),
    cursor, limit: requestedLimit, defaultLimit: requestedLimit,
    maxLimit: Math.min(maxLimit, MAX_OUTPUT_PAGE_SIZE),
  });
  return {
    runId: session.run.runId,
    revision: session.revision,
    source,
    maxBytes: boundedMax,
    ...result,
  };
}

export function projectReportResource(value, { legacyRun = null } = {}) {
  const session = validateRunSessionRecord(value);
  const redact = createRedactor(session, legacyRun);
  const summary = projectPublicSummary(session.publicSummary, redact);
  const legacy = isObject(legacyRun) ? legacyRun : {};
  const counts = firstCounts(manifestCounts(session.executionManifest), legacy.plan?.counts, summary.counts);
  return {
    runId: session.run.runId,
    revision: session.revision,
    kind: session.run.kind,
    status: session.run.status,
    project: {
      projectId: session.binding.projectId,
      name: safeText(summary.projectName ?? legacy.projectName ?? '', redact) || null,
    },
    workflow: {
      revision: session.binding.workflowRevision,
      name: safeText(summary.workflowName ?? legacy.workflowName ?? '', redact) || null,
    },
    archive: session.binding.blobId ? {
      blobId: session.binding.blobId,
      sha256: session.binding.blobSha256,
      filename: safeFilename(summary.archiveName ?? legacy.archivePath),
      size: safeInteger(summary.archive?.size ?? legacy.archiveInfo?.size),
      fileCount: safeInteger(summary.archive?.fileCount ?? legacy.archiveInfo?.fileCount),
    } : null,
    summary,
    plan: { counts },
    checks: projectChecks(legacy.checks ?? summary.checks, redact),
    commit: projectCommit(legacy.commit ?? summary.commit, redact),
    deploy: projectDeploy(legacy.deploy ?? summary.deploy, redact),
    rollback: isObject(legacy.rollback) ? { status: safeText(legacy.rollback.status, redact) || null } : null,
    decisions: projectDecisions(legacy.decisions, redact),
    llm: projectLlm(legacy.llm, redact),
    llmFailure: projectLlmFailure(legacy.llmFailure, redact),
    autonomy: projectAutonomy(legacy.autonomy),
    archiveSafety: projectArchiveSafety(legacy.archiveSafety, redact),
    applied: isObject(legacy.applied) ? {
      backupAvailable: legacy.applied.backupAvailable !== false
        && legacy.rollback?.status !== 'completed',
    } : null,
    error: projectError(legacy.error ?? summary.error, redact),
    createdAt: session.run.createdAt,
    updatedAt: session.run.updatedAt,
    completedAt: session.run.completedAt,
  };
}

export function assertManifestDiffPath(value, requestedPath) {
  const session = validateRunSessionRecord(value);
  let normalized;
  try {
    normalized = normalizeManifestPath(requestedPath);
  } catch (error) {
    throw runSessionError('Diff path must be a normalized manifest path.', 'INVALID_DIFF_PATH', 400, null, error);
  }
  const item = findManifestDiffItem(session.executionManifest, normalized);
  if (!item) throw runSessionError('Diff path is not present in the run manifest.', 'DIFF_PATH_NOT_IN_MANIFEST', 404);
  return item;
}

export function projectDiffResource(value, {
  path: requestedPath,
  mode = 'unified',
  diff,
  context = 3,
  maxLines = MAX_DIFF_RESPONSE_LINES,
} = {}) {
  const session = validateRunSessionRecord(value);
  const item = assertManifestDiffPath(session, requestedPath);
  if (!['unified', 'side-by-side'].includes(mode)) throw runSessionError('Diff mode is invalid.', 'INVALID_DIFF_MODE', 400);
  if (!isObject(diff) || !Array.isArray(diff.rows)) throw new TypeError('Semantic diff is required.');
  const redact = createRedactor(session);
  if (diff.binary) return {
    runId: session.run.runId, revision: session.revision, path: item.path, kind: item.kind,
    mode, binary: true, message: safeText(diff.message ?? 'Binary or large file.', redact),
    hunks: [], truncation: { truncated: false, omittedLines: 0 },
  };
  const ranges = changedRanges(diff.rows, normalizeContext(context));
  const hardMax = Math.min(normalizePositiveInteger(maxLines, 'Diff line limit'), MAX_DIFF_RESPONSE_LINES);
  let remaining = hardMax;
  let omittedLines = 0;
  const hunks = [];
  for (const range of ranges) {
    const rows = diff.rows.slice(range.start, range.end + 1);
    const included = rows.slice(0, remaining);
    omittedLines += rows.length - included.length;
    if (included.length) hunks.push(projectHunk(included, redact));
    remaining -= included.length;
    if (remaining === 0) omittedLines += ranges.slice(hunks.length).reduce((sum, itemRange) => sum + itemRange.end - itemRange.start + 1, 0);
    if (remaining === 0) break;
  }
  return {
    runId: session.run.runId, revision: session.revision, path: item.path, kind: item.kind,
    mode, binary: false, hunks,
    truncation: { truncated: omittedLines > 0, omittedLines },
  };
}

function projectPublicSummary(value, redact) {
  const summary = isObject(value) ? value : {};
  const result = {};
  const textFields = {
    title: summary.title ?? summary.surfaceTitle,
    summary: summary.summary ?? summary.surfaceSummary,
    projectName: summary.projectName ?? summary.project?.name,
    workflowName: summary.workflowName ?? summary.workflow?.name,
  };
  for (const [key, text] of Object.entries(textFields)) {
    if (typeof text === 'string') result[key] = safeText(text, redact);
  }
  if (summary.archiveName != null || summary.archive?.filename != null) {
    result.archiveName = safeFilename(summary.archiveName ?? summary.archive.filename);
  }
  const counts = firstCounts(summary.counts, summary.plan?.counts);
  if (Object.keys(counts).length) result.counts = counts;
  const checks = projectChecks(summary.checks, redact);
  if (checks) result.checks = checks;
  const deploy = projectDeploy(summary.deploy, redact);
  if (deploy) result.deploy = deploy;
  const commit = projectCommit(summary.commit, redact);
  if (commit) result.commit = commit;
  const error = projectError(summary.error, redact);
  if (error) result.error = error;
  const llm = projectLlm(summary.llm, redact);
  if (llm) result.llm = llm;
  return result;
}

function projectPlanItem(item, redact, decision = undefined) {
  const result = { path: item.path, kind: safeText(item.kind ?? 'updated', redact) };
  if (decision === 'archive' || decision === 'keep' || decision === null) {
    result.decision = decision;
  }
  for (const key of ['beforeHash', 'afterHash', 'hash']) {
    if (item[key] == null) result[key] = null;
    else if (/^[a-f0-9]{64}$/.test(item[key])) result[key] = item[key];
  }
  for (const key of ['mode', 'size']) if (Number.isSafeInteger(item[key]) && item[key] >= 0) result[key] = item[key];
  for (const key of ['reason', 'gitStatus']) if (typeof item[key] === 'string') result[key] = safeText(item[key], redact);
  return result;
}

function projectOutputItem(item, redact, maxBytes) {
  const sanitized = safeText(item.text, redact);
  const limited = truncateUtf8(sanitized, maxBytes);
  return {
    sequence: item.sequence, source: item.source, stream: item.stream,
    commandId: item.commandId, checkId: item.checkId, text: limited.text,
    truncated: item.truncated || limited.truncated,
    omittedBytes: item.omittedBytes + limited.omittedBytes,
    createdAt: item.createdAt,
  };
}

function projectChecks(value, redact) {
  if (!isObject(value)) return null;
  const result = {};
  for (const key of ['passed', 'failed', 'skipped']) {
    const numeric = safeInteger(value[key]);
    if (numeric !== null) result[key] = numeric;
  }
  if (typeof value.ok === 'boolean') result.ok = value.ok;
  if (Array.isArray(value.results)) result.results = value.results.slice(0, 500).map((item) => ({
    id: safeText(item?.id ?? '', redact) || null,
    name: safeText(item?.name ?? '', redact) || null,
    ok: Boolean(item?.ok), required: item?.required !== false,
    code: safeInteger(item?.code), durationMs: safeInteger(item?.durationMs),
    cwd: safeRelativeDirectory(item?.cwd),
  }));
  return result;
}

function projectCommit(value, redact) {
  if (!isObject(value)) return null;
  return {
    revision: safeText(value.revision ?? '', redact) || null,
    message: safeText(value.message ?? '', redact) || null,
  };
}

function projectDeploy(value, redact) {
  if (!isObject(value)) return null;
  return {
    ok: typeof value.ok === 'boolean' ? value.ok : null,
    skipped: Boolean(value.skipped), cancelled: Boolean(value.cancelled),
    policy: safeText(value.policy ?? '', redact) || null,
    commandText: safeText(value.commandText ?? '', redact) || null,
    cwd: safeRelativeDirectory(value.cwd),
    code: safeInteger(value.code), durationMs: safeInteger(value.durationMs),
  };
}

function projectDecisions(values, redact) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 500).map((value) => {
    const result = {};
    for (const key of [
      'id', 'gate', 'action', 'proposedAction', 'label', 'screen', 'source',
      'executionStatus', 'executionError', 'summary', 'model', 'at',
    ]) {
      if (typeof value?.[key] === 'string') result[key] = safeText(value[key], redact);
    }
    for (const key of ['confidence', 'effectiveConfidence']) {
      if (Number.isFinite(value?.[key])) result[key] = Math.max(0, Math.min(1, value[key]));
    }
    for (const key of ['allowedActions', 'evidence', 'risks', 'conditions']) {
      if (Array.isArray(value?.[key])) {
        result[key] = value[key].slice(0, 8).map((item) => safeText(item, redact));
      }
    }
    result.accepted = value?.accepted === true;
    result.stateDrift = value?.stateDrift === true;
    return result;
  });
}

function projectLlm(value, redact) {
  if (!isObject(value)) return null;
  const result = {
    status: ['running', 'completed', 'failed', 'cancelled'].includes(value.status)
      ? value.status
      : null,
    durationMs: safeInteger(value.durationMs),
    provider: safeText(value.provider ?? '', redact) || null,
    model: safeText(value.model ?? '', redact) || null,
    language: safeText(value.language ?? '', redact) || null,
    assessment: safeText(value.assessment ?? '', redact) || null,
    confidence: safeText(value.confidence ?? '', redact) || null,
    warning: safeText(value.warning ?? '', redact) || null,
    commitMessage: safeText(value.commitMessage ?? '', redact) || null,
    error: safeText(value.error ?? '', redact) || null,
    cancelled: Boolean(value.cancelled),
  };
  if (Array.isArray(value.summary)) {
    result.summary = value.summary.slice(0, 100).map((line) => safeText(line, redact));
  }
  if (Array.isArray(value.reasons)) {
    result.reasons = value.reasons.slice(0, 100).map((line) => safeText(line, redact));
  }
  return result;
}

function projectLlmFailure(value, redact) {
  if (!isObject(value)) return null;
  return {
    status: ['completed', 'failed', 'cancelled'].includes(value.status)
      ? value.status
      : value.cancelled ? 'cancelled' : value.error ? 'failed' : 'completed',
    text: safeText(value.text ?? '', redact) || null,
    mode: safeText(value.mode ?? '', redact) || null,
    provider: safeText(value.provider ?? '', redact) || null,
    model: safeText(value.model ?? '', redact) || null,
    durationMs: safeInteger(value.durationMs),
    cancelled: Boolean(value.cancelled),
    error: safeText(value.error ?? '', redact) || null,
  };
}

function projectAutonomy(value) {
  if (!isObject(value)) return null;
  return {
    mode: ['manual', 'guarded', 'full'].includes(value.mode) ? value.mode : 'manual',
    paused: Boolean(value.paused),
    fallbackCount: safeInteger(value.fallbackCount) ?? 0,
    checkRetries: safeInteger(value.checkRetries) ?? 0,
    deployRetries: safeInteger(value.deployRetries) ?? 0,
  };
}

function projectArchiveSafety(value, redact) {
  if (!isObject(value)) return null;
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  return {
    warnings: warnings.slice(0, 500).map((warning) => {
      if (typeof warning === 'string') return { message: safeText(warning, redact) };
      return {
        code: safeText(warning?.code ?? warning?.id ?? '', redact) || null,
        message: safeText(
          warning?.message
            ?? ([warning?.title, warning?.detail].filter(Boolean).join(': ') || warning?.reason)
            ?? warning?.reason
            ?? '',
          redact,
        ),
        severity: safeText(warning?.severity ?? '', redact) || null,
      };
    }),
    acknowledged: value.acknowledged === true,
    llm: projectSafetyAssessment(value.llm, redact),
    deletionIntent: projectSafetyAssessment(value.deletionIntent, redact),
  };
}

function projectSafetyAssessment(value, redact) {
  if (!isObject(value)) return null;
  return {
    mode: safeText(value.mode ?? '', redact) || null,
    assessment: safeText(value.assessment ?? '', redact) || null,
    confidence: safeText(value.confidence ?? '', redact) || null,
    recommendation: safeText(value.recommendation ?? '', redact) || null,
    projectRelation: safeText(value.projectRelation ?? '', redact) || null,
    archiveShape: safeText(value.archiveShape ?? '', redact) || null,
    reasons: Array.isArray(value.reasons)
      ? value.reasons.slice(0, 5).map((reason) => safeText(reason, redact))
      : [],
  };
}

function projectError(value, redact) {
  if (value == null) return null;
  if (typeof value === 'string') return { message: safeText(value, redact) };
  if (!isObject(value)) return { message: safeText(String(value), redact) };
  return {
    code: typeof value.code === 'string' ? safeText(value.code, redact) : null,
    message: safeText(value.message ?? String(value), redact),
  };
}

function projectCorrelation(value, redact) {
  if (!isObject(value)) return null;
  const result = {};
  for (const key of ['producer', 'workflowId', 'requestId']) {
    if (typeof value[key] === 'string') result[key] = safeText(value[key], redact);
  }
  return Object.keys(result).length ? result : null;
}

function createRedactor(session, legacyRun = null) {
  const privatePaths = new Set([session.binding.projectPath]);
  collectKeyedPaths(session.executionManifest, privatePaths);
  collectKeyedPaths(legacyRun, privatePaths);
  const values = [...privatePaths].filter(Boolean).sort((left, right) => right.length - left.length);
  return (text) => values.reduce((result, privatePath) => result.replaceAll(privatePath, '[redacted-path]'), text);
}

function collectKeyedPaths(value, result, key = '', depth = 0) {
  if (depth > 32 || value == null) return;
  if (typeof value === 'string') {
    if (/path$/i.test(key) && (path.isAbsolute(value) || path.win32.isAbsolute(value))) result.add(value);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item) => collectKeyedPaths(item, result, key, depth + 1));
  if (!isObject(value)) return;
  for (const [childKey, child] of Object.entries(value)) collectKeyedPaths(child, result, childKey, depth + 1);
}

function safeText(value, redact) {
  const stripped = stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return redact(stripped);
}

function safeFilename(value) {
  if (value == null) return null;
  const normalized = String(value).replaceAll('\\', '/');
  return stripVTControlCharacters(path.posix.basename(normalized)).replace(/[\u0000-\u001f\u007f]/g, '') || null;
}

function safeRelativeDirectory(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).replaceAll('\\', '/').replace(/^\.\//, '') || '.';
  if (normalized === '.') return '.';
  try {
    return normalizeManifestPath(normalized);
  } catch {
    return null;
  }
}

function safeCounts(value) {
  if (!isObject(value)) return {};
  const result = {};
  for (const key of COUNT_KEYS) {
    const numeric = safeInteger(value[key]);
    if (numeric !== null) result[key] = numeric;
  }
  return result;
}

function manifestCounts(manifest) {
  return firstCounts(manifest?.counts, manifest?.plan?.counts);
}

function firstCounts(...values) {
  for (const value of values) {
    const counts = safeCounts(value);
    if (Object.keys(counts).length) return counts;
  }
  return {};
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function attentionForStatus(status) {
  if (status === 'waiting_action') return 'action_required';
  if (status === 'uncertain') return 'reconciliation_required';
  if (status === 'failed') return 'failed';
  return null;
}

function normalizeOutputBytes(value) {
  return Math.min(normalizePositiveInteger(value, 'Output byte limit'), MAX_OUTPUT_RESPONSE_BYTES);
}

function normalizeRequestedLimit(value, maxLimit) {
  if (value == null || value === '') return Math.min(25, maxLimit);
  const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Math.min(normalizePositiveInteger(numeric, 'Output page limit'), maxLimit);
}

function normalizePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function normalizeContext(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 20) : 3;
}

function changedRanges(rows, context) {
  const ranges = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.type === 'same') continue;
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length - 1, index + context);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

function projectHunk(rows, redact) {
  const oldNumbers = rows.map((row) => row?.oldNo).filter(Number.isFinite);
  const newNumbers = rows.map((row) => row?.newNo).filter(Number.isFinite);
  return {
    oldStart: oldNumbers[0] ?? 0, oldCount: oldNumbers.length,
    newStart: newNumbers[0] ?? 0, newCount: newNumbers.length,
    lines: rows.map((row) => ({
      type: ['same', 'add', 'remove'].includes(row?.type) ? row.type : 'same',
      oldLine: Number.isFinite(row?.oldNo) ? row.oldNo : null,
      newLine: Number.isFinite(row?.newNo) ? row.newNo : null,
      oldText: safeText(row?.oldText ?? '', redact),
      newText: safeText(row?.newText ?? '', redact),
    })),
  };
}

function truncateUtf8(value, maxBytes) {
  const source = Buffer.from(value);
  if (source.length <= maxBytes) return { text: value, truncated: false, omittedBytes: 0 };
  let end = maxBytes;
  let text = source.subarray(0, end).toString('utf8');
  while (text.endsWith('\uFFFD') && end > 0) text = source.subarray(0, --end).toString('utf8');
  return { text, truncated: true, omittedBytes: source.length - Buffer.byteLength(text) };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
