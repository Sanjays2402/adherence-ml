/**
 * Tiny CSV utilities (RFC 4180-ish). No deps.
 *
 * parseCsv() handles quoted fields, embedded commas, escaped quotes ("")
 * and CRLF/LF line endings. Good enough for human-uploaded batch files.
 * Streams are not supported; we cap at MAX_BYTES upstream.
 */

export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      // skip CRLF pair
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      // ignore fully empty lines
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // flush last
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
  }
  if (rows.length === 0) return { header: [], rows: [] };
  const header = rows[0].map((h) => h.trim());
  return { header, rows: rows.slice(1) };
}

function escapeCsvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(header: string[], rows: Array<Array<unknown>>): string {
  const lines = [header.map(escapeCsvField).join(",")];
  for (const r of rows) lines.push(r.map(escapeCsvField).join(","));
  return lines.join("\n") + "\n";
}
