const UNITS = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

export function parseByteSize(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)?$/i);
  if (!match) throw new Error('Enter a size such as 500MB, 1GB, or 2GiB.');
  const unit = (match[2] || 'b').toLowerCase();
  const multiplier = UNITS[unit];
  if (!multiplier) throw new Error(`Unsupported size unit: ${match[2]}`);
  const result = Number(match[1]) * multiplier;
  if (!Number.isFinite(result) || result < 0) throw new Error('Archive size limit is invalid.');
  return Math.floor(result);
}

export function formatByteSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1000 ** 3) return `${trim(value / (1000 ** 3))} GB`;
  if (value >= 1000 ** 2) return `${trim(value / (1000 ** 2))} MB`;
  if (value >= 1000) return `${trim(value / 1000)} KB`;
  return `${value} B`;
}

function trim(value) {
  return Number(value.toFixed(value >= 10 ? 1 : 2)).toString();
}
