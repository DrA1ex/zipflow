import path from 'node:path';
import { stat, statfs } from 'node:fs/promises';
import { formatByteSize } from '../utils/size.js';

const MIB = 1024 * 1024;
const FIXED_RESERVE_BYTES = 8 * MIB;

export function estimateArchiveExtractionRequirements({ expandedBytes = 0, entryCount = 0 } = {}) {
  const extraction = safeBytes(expandedBytes);
  const metadata = Math.max(MIB, safeBytes(entryCount) * 512);
  return {
    extraction,
    metadata,
    reserve: FIXED_RESERVE_BYTES,
    total: extraction + metadata + FIXED_RESERVE_BYTES,
  };
}

export async function estimateApplyRequirements(items, { signal = null } = {}) {
  let backup = 0;
  let replacementPeak = 0;
  for (const item of items) {
    throwIfCancelled(signal);
    if (item.kind !== 'created') {
      try {
        backup += Number((await stat(item.currentPath)).size);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (item.kind !== 'deleted') {
      replacementPeak = Math.max(replacementPeak, await fileSizeIfPresent(item.sourcePath));
    }
  }
  return {
    zipflow: {
      backup,
      manifest: Math.max(MIB, items.length * 1024),
      reserve: FIXED_RESERVE_BYTES,
      total: backup + Math.max(MIB, items.length * 1024) + FIXED_RESERVE_BYTES,
    },
    project: {
      replacement: replacementPeak,
      reserve: FIXED_RESERVE_BYTES,
      total: replacementPeak + FIXED_RESERVE_BYTES,
    },
  };
}

export async function assertArchiveExtractionSpace({
  destination,
  expandedBytes,
  entryCount,
  probe = probeFilesystem,
} = {}) {
  const requirements = estimateArchiveExtractionRequirements({ expandedBytes, entryCount });
  await assertCapacity([
    { label: 'Zipflow storage', path: destination, required: requirements.total, details: requirements },
  ], { probe });
  return requirements;
}

export async function assertApplySpace({
  projectPath,
  zipflowPath,
  items,
  signal = null,
  probe = probeFilesystem,
} = {}) {
  const requirements = await estimateApplyRequirements(items, { signal });
  await assertCapacity([
    { label: 'Zipflow storage', path: zipflowPath, required: requirements.zipflow.total, details: requirements.zipflow },
    { label: 'project filesystem', path: projectPath, required: requirements.project.total, details: requirements.project },
  ], { probe });
  return requirements;
}

export async function assertCapacity(checks, { probe = probeFilesystem } = {}) {
  const inspected = [];
  for (const check of checks) {
    const filesystem = await probe(check.path);
    inspected.push({ ...check, ...filesystem });
  }
  const groups = new Map();
  for (const check of inspected) {
    const key = check.device == null ? `${check.path}:${groups.size}` : String(check.device);
    const existing = groups.get(key) ?? { available: check.available, required: 0, checks: [] };
    existing.available = Math.min(existing.available, check.available);
    existing.required += safeBytes(check.required);
    existing.checks.push(check);
    groups.set(key, existing);
  }
  for (const group of groups.values()) {
    if (group.available >= group.required) continue;
    const labels = group.checks.map((item) => item.label).join(' and ');
    const error = new Error(`Insufficient disk space on ${labels}: ${formatByteSize(group.required)} required, ${formatByteSize(group.available)} available.`);
    error.code = 'insufficient_disk_space';
    error.requiredBytes = group.required;
    error.availableBytes = group.available;
    error.filesystems = group.checks.map((item) => ({ label: item.label, path: item.path, requiredBytes: item.required }));
    throw error;
  }
  return inspected;
}

export async function probeFilesystem(target) {
  const existing = await nearestExistingPath(target);
  const [filesystem, info] = await Promise.all([
    statfs(existing, { bigint: true }),
    stat(existing, { bigint: true }),
  ]);
  const blockSize = filesystem.bsize ?? filesystem.frsize ?? 0n;
  const availableBlocks = filesystem.bavail ?? filesystem.bfree ?? 0n;
  return {
    path: existing,
    device: info.dev,
    available: safeNumber(blockSize * availableBlocks),
  };
}

async function nearestExistingPath(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function fileSizeIfPresent(filePath) {
  try {
    return Number((await stat(filePath)).size);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function safeNumber(value) {
  if (typeof value !== 'bigint') return safeBytes(value);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function safeBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number) : 0;
}

function throwIfCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Operation cancelled.');
  error.code = 'cancelled';
  throw error;
}
