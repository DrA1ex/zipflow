export function canonicalModelId(provider, model, { records = [] } = {}) {
  const value = String(model ?? '').trim();
  if (!value) return '';
  if (provider !== 'lmstudio') return value;
  for (const record of records ?? []) {
    const key = String(record?.key ?? record?.id ?? '').trim();
    const ids = [key, ...(record?.ids ?? []), ...(record?.loadedInstanceIds ?? [])].filter(Boolean);
    if (ids.includes(value)) return key || value;
  }
  return value.replace(/:\d+(?:\.\d+)?$/, '');
}

export function modelIdentityKey(provider, model, options = {}) {
  return `${String(provider ?? 'unknown')}::${canonicalModelId(provider, model, options)}`;
}

export function modelAnalyticsLabel(provider, model, options = {}) {
  return `${String(provider ?? 'unknown')} · ${canonicalModelId(provider, model, options) || 'unknown'}`;
}
