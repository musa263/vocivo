/** Quote every CSV field and neutralize spreadsheet formulas, including leading control characters. */
export function csvCell(value: unknown) {
  let text = value == null ? '' : String(value);
  if (/^[\s\x00-\x1f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function reportCsv(calls: Array<Record<string, unknown>>) {
  const keys = ['startedAt', 'direction', 'from', 'to', 'status', 'answeredAt', 'endedAt', 'durationSeconds', 'hangupCause', 'cost'];
  return [keys.map(csvCell).join(','), ...calls.map(c => keys.map(key => csvCell(c[key])).join(','))].join('\r\n');
}
