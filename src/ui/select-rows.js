export function selectRows(items, getLabel) {
  return (items ?? []).map((item, index) => ({
    id: item?.id ?? `row-${index}`,
    label: selectRowLabel(getLabel(item, index), item),
    disabled: Boolean(item?.disabled),
    blocked: Boolean(item?.blocked),
    loading: Boolean(item?.loading),
    sourceIndex: index,
  }));
}

export function selectRowIndex(row, fallbackIndex = 0) {
  return Number.isInteger(row?.sourceIndex) ? row.sourceIndex : fallbackIndex;
}

export function selectRowLabel(value, source = null) {
  let label = String(value ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/[\t ]{2,}/g, ' ')
    .trim();

  // Terlio 1.1.x can render secondary item fields inline. Zipflow keeps all
  // explanation in ContextDock, so defensively remove an accidentally joined
  // secondary field before handing the row to SelectList.
  for (const detail of [source?.description, source?.context, source?.help, source?.disabledReason]) {
    const normalized = String(detail ?? '')
      .replace(/\s*\r?\n\s*/g, ' ')
      .replace(/[\t ]{2,}/g, ' ')
      .trim();
    if (!normalized) continue;
    for (const separator of [' — ', ' – ', ' - ']) {
      const suffix = `${separator}${normalized}`;
      if (label.endsWith(suffix)) label = label.slice(0, -suffix.length).trimEnd();
    }
  }
  return label;
}
