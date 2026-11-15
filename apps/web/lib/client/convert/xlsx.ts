"use client";

import type { Cellish, PageLayout } from "./layout";

/**
 * Excel workbook from page layouts: one sheet per page, text placed into rows
 * (shared baselines) and columns (the x ranges table rows occupy, split at the
 * gaps between them). Amounts like 1,24,500.00, ₹ 500, (1,200) or 12.5% become
 * real numbers.
 */

export type Grid = Array<Array<string | number | null>>;

/** Parse a cell as a number if it clearly is one (Indian or Western grouping, currency, %, brackets). */
export function asNumber(text: string): { value: number; percent: boolean; decimals: number } | null {
  let s = text.trim();
  if (!s || s.length > 30) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/^(₹|Rs\.?|INR|\$|€|£)\s*/i, "").replace(/\s*(₹|INR)$/i, "");
  if (s.startsWith("-") || s.startsWith("−")) { neg = !neg; s = s.slice(1).trim(); }
  const percent = s.endsWith("%");
  if (percent) s = s.slice(0, -1).trim();
  if (!/^(\d{1,3}(,\d{2,3})*|\d+)(\.\d+)?$/.test(s)) return null;
  const digits = s.replace(/,/g, "");
  // Leading-zero codes (PIN, account numbers) stay text.
  if (/^0\d/.test(digits) || digits.replace(".", "").length > 15) return null;
  const v = Number(digits);
  if (!Number.isFinite(v)) return null;
  return { value: (neg ? -v : v) / (percent ? 100 : 1), percent, decimals: (digits.split(".")[1] ?? "").length };
}

/** Place a page's text into a grid. */
export function toGrid(cells: Cellish[]): Grid {
  // 1. Join runs that are really one cell (PDF.js splits words and styles).
  const sorted = [...cells].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const rows: Cellish[][] = [];
  for (const c of sorted) {
    const row = rows.find((r) => Math.abs(r[0]!.baseline - c.baseline) < Math.max(1.2, c.size * 0.4));
    if (row) row.push({ ...c });
    else rows.push([{ ...c }]);
  }
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1]!, cur = row[i]!;
      if (cur.x - prev.x1 < Math.max(prev.size, cur.size) * 0.55) {
        prev.text = `${prev.text}${cur.x - prev.x1 > prev.size * 0.12 ? " " : ""}${cur.text}`;
        prev.x1 = Math.max(prev.x1, cur.x1);
        row.splice(i--, 1);
      }
    }
  }
  rows.sort((a, b) => a[0]!.baseline - b[0]!.baseline);

  // 2. Columns: x ranges covered by multi-cell rows, split at gaps.
  const spans = rows.filter((r) => r.length >= 2).flat().map((c) => [c.x, c.x1] as [number, number]).sort((a, b) => a[0] - b[0]);
  const cols: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const last = cols[cols.length - 1];
    if (last && a <= last[1] + 3) last[1] = Math.max(last[1], b);
    else cols.push([a, b]);
  }
  const colOf = (c: Cellish) => {
    if (!cols.length) return 0;
    const mid = (c.x + c.x1) / 2;
    let best = 0, dist = Infinity;
    cols.forEach(([a, b], i) => {
      const d = mid < a ? a - mid : mid > b ? mid - b : 0;
      if (d < dist) { dist = d; best = i; }
    });
    return best;
  };

  // 3. Grid, with a blank row where the page has a big vertical gap.
  const grid: Grid = [];
  let prevBase: number | null = null;
  for (const row of rows) {
    const base = row[0]!.baseline, size = row[0]!.size;
    if (prevBase !== null && base - prevBase > size * 2.6) grid.push([]);
    prevBase = base;
    const line: Array<string | number | null> = Array(Math.max(1, cols.length)).fill(null);
    for (const c of row) {
      const i = row.length === 1 ? 0 : colOf(c);
      const n = asNumber(c.text);
      const v = n ? n.value : c.text;
      line[i] = line[i] === null ? v : `${line[i]} ${c.text}`;
    }
    while (line.length && line[line.length - 1] === null) line.pop();
    grid.push(line);
  }
  return grid;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const colName = (i: number) => { let s = ""; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

/** Minimal valid .xlsx: inline strings, numbers with a 2-decimal or % format, column widths. */
export async function gridsToXlsx(sheets: Array<{ name: string; grid: Grid; formats?: Array<Array<"dec" | "pct" | null>> }>): Promise<Uint8Array> {
  const { zipSync, strToU8 } = await import("fflate");
  const files: Record<string, Uint8Array> = {};
  const names = sheets.map((s, i) => esc(s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet${i + 1}`));

  sheets.forEach((sheet, si) => {
    const widths: number[] = [];
    const rowsXml = sheet.grid.map((row, ri) => {
      // Lone text lines (titles, notes) overflow into the next cells; only table rows size the columns.
      const sizes = row.filter((v) => v !== null && v !== "").length > 1;
      const cells = row.map((v, ci) => {
        if (v === null || v === "") return "";
        const ref = `${colName(ci)}${ri + 1}`;
        if (sizes) widths[ci] = Math.max(widths[ci] ?? 6, Math.min(60, String(v).length + 2));
        if (typeof v === "number") {
          const f = sheet.formats?.[ri]?.[ci];
          return `<c r="${ref}"${f === "dec" ? ' s="1"' : f === "pct" ? ' s="2"' : ""}><v>${v}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }).join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join("");
    const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w ?? 8}" customWidth="1"/>`).join("")}</cols>` : "";
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rowsXml}</sheetData></worksheet>`);
  });

  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files["xl/workbook.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  files["xl/styles.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`);
  return zipSync(files, { level: 6 });
}

/** Workbook for page layouts (one sheet per page with any text). */
export async function layoutsToXlsx(pages: PageLayout[]): Promise<Uint8Array> {
  const sheets = pages.map((p, i) => {
    const grid = toGrid(p.cells);
    // Number formats: decimals and percentages as they were written.
    const formats = grid.map((row, ri) => row.map((v, ci) => {
      if (typeof v !== "number") return null;
      const src = p.cells.find((c) => asNumber(c.text)?.value === v);
      const n = src ? asNumber(src.text) : null;
      void ri; void ci;
      return n?.percent ? "pct" : n && n.decimals > 0 ? "dec" : null;
    }));
    return { name: `Page ${i + 1}`, grid, formats };
  });
  return gridsToXlsx(sheets.length ? sheets : [{ name: "Sheet1", grid: [] }]);
}
