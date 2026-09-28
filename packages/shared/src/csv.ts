/**
 * Minimal RFC 4180 CSV parser for the seed files: quoted fields, escaped
 * quotes, and commas inside quotes. Empty fields become null, so an empty
 * `estimated_arrival` loads as NULL rather than as an invalid date.
 */
export function parseCsv(text: string): Record<string, string | null>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);

  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => {
    const out: Record<string, string | null> = {};
    header.forEach((h, i) => {
      const v = (r[i] ?? "").trim();
      out[h.trim()] = v === "" ? null : v;
    });
    return out;
  });
}
