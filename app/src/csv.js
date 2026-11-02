// CSV for the finance export (client request, 2 Nov): RFC 4180 quoting,
// true/false for booleans, an empty field for null.

export const CSV_COLUMNS = [
  "id", "site_id", "responder_id", "responder", "response_business_minutes", "within_target", "completed_late",
];

// A field is quoted when it contains a comma, a quote or a line break; quotes are doubled.
export function csvField(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// Header line plus one line per row, each ending in a newline.
export function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => csvField(row[column])).join(","));
  return lines.join("\n") + "\n";
}
