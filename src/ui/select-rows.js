export function selectRows(items, getLabel) {
  return (items ?? []).map((item, index) => ({
    id: item?.id ?? `row-${index}`,
    label: getLabel(item, index),
    disabled: Boolean(item?.disabled),
    blocked: Boolean(item?.blocked),
    loading: Boolean(item?.loading),
    sourceIndex: index,
  }));
}

export function selectRowIndex(row, fallbackIndex = 0) {
  return Number.isInteger(row?.sourceIndex) ? row.sourceIndex : fallbackIndex;
}
