/** One CSV cell: always quoted, and a leading = + - @ tab or CR is neutralised so spreadsheets don't run it as a formula. */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
}

/** Rows to a CSV document (CRLF line endings, as spreadsheets expect). */
export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
