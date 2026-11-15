import type { Rect } from "./operations";
import { rectFromTextFrame, textRotation, toTextFrame } from "./visual";

/**
 * Find personal data in a page's text (as PDF.js reports it: runs of text with a
 * transform and a width) and return boxes to redact. Matches are found on whole
 * lines, so a number split across runs (or OCR words) is still caught; each
 * character's position inside a run is estimated from Helvetica's widths, which
 * is close for digits and capitals, and the box gets a small margin.
 */

export type PiiKind = "aadhaar" | "pan" | "phone" | "email" | "ifsc" | "bank" | "custom";

export const PII_LABEL: Record<PiiKind, string> = {
  aadhaar: "Aadhaar",
  pan: "PAN",
  phone: "Phone",
  email: "Email / UPI ID",
  ifsc: "IFSC",
  bank: "Bank account",
  custom: "Search",
};

export interface TextRun {
  str: string;
  /** PDF.js item transform [a, b, c, d, e, f] in PDF space. */
  transform: number[];
  /** Advance width along the text direction, PDF points. */
  width: number;
}

export interface PiiMatch {
  kind: PiiKind;
  text: string;
  rect: Rect;
}

/* ---------------------------------------------------------- validation */

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff checksum, used by Aadhaar numbers (rules out most random 12-digit numbers). */
export function verhoeffValid(digits: string): boolean {
  let c = 0;
  const ds = digits.replace(/\D/g, "").split("").reverse();
  ds.forEach((d, i) => { c = D[c]![P[i % 8]![Number(d)]!]!; });
  return ds.length > 0 && c === 0;
}

/* ------------------------------------------------------------ patterns */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function patterns(kinds: PiiKind[], custom?: string): Array<{ kind: PiiKind; re: RegExp; ok?: (m: string, line: string) => boolean }> {
  const all: Array<{ kind: PiiKind; re: RegExp; ok?: (m: string, line: string) => boolean }> = [
    { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
    // UPI IDs: name@bank handle, no dot after the @.
    { kind: "email", re: /(?<![\w.@-])[\w.-]{2,}@(?:ok)?[a-z]{2,}(?![\w.@-])/gi },
    { kind: "aadhaar", re: /(?<![\dA-Za-z])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![\dA-Za-z])/g, ok: (m) => verhoeffValid(m) },
    { kind: "pan", re: /(?<![A-Za-z0-9])[A-Z]{3}[ABCFGHLJPTK][A-Z]\d{4}[A-Z](?![A-Za-z0-9])/g },
    { kind: "ifsc", re: /(?<![A-Za-z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Za-z0-9])/g },
    { kind: "phone", re: /(?<![\d+])(?:\+91[ -]?|0091[ -]?|0)?[6-9]\d{4}[ -]?\d{5}(?!\d)/g },
    // Account numbers are just digits: only on lines that talk about an account.
    { kind: "bank", re: /(?<![\d])\d{9,18}(?!\d)/g, ok: (_m, line) => /\b(a\/?c|acc(?:oun)?t|acct|account no|bank)\b/i.test(line) },
  ];
  const out = all.filter((p) => kinds.includes(p.kind));
  const q = custom?.trim();
  if (kinds.includes("custom") && q) out.push({ kind: "custom", re: new RegExp(escape(q).replace(/\s+/g, "\\s*"), "gi") });
  return out;
}

/* -------------------------------------------------------------- layout */

const HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,556,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
const charWidth = (c: string) => {
  const code = c.charCodeAt(0);
  return code >= 32 && code < 256 ? HELVETICA[code - 32]! : 556;
};

interface Run { str: string; x: number; y: number; w: number; size: number; rot: 0 | 90 | 180 | 270 }

/** x offset (text frame) of each character boundary in a run, by Helvetica weights. */
function boundaries(run: Run): number[] {
  const ws = Array.from(run.str, charWidth);
  const total = ws.reduce((a, b) => a + b, 0) || 1;
  const out = [run.x];
  let acc = 0;
  for (const w of ws) { acc += w; out.push(run.x + (run.w * acc) / total); }
  return out;
}

interface Line { text: string; map: Array<{ run: Run; i: number } | null>; rot: 0 | 90 | 180 | 270 }

function lines(runs: TextRun[]): Line[] {
  const items: Run[] = [];
  for (const r of runs) {
    const t = r.transform;
    if (!r.str || t.length < 6) continue;
    const rot = textRotation(t[0]!, t[1]!, t[2]!, t[3]!);
    if (rot === null) continue;
    const [x, y] = toTextFrame(rot, t[4]!, t[5]!);
    items.push({ str: r.str, x, y, w: r.width, size: Math.hypot(t[2]!, t[3]!) || 1, rot });
  }
  const out: Line[] = [];
  for (const rot of [0, 90, 180, 270] as const) {
    const mine = items.filter((i) => i.rot === rot).sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: Run[][] = [];
    for (const it of mine) {
      const row = rows.find((r) => Math.abs(r[0]!.y - it.y) < Math.max(0.5, it.size * 0.3));
      if (row) row.push(it);
      else rows.push([it]);
    }
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      let text = "";
      const map: Line["map"] = [];
      let prevEnd: number | null = null;
      for (const it of row) {
        if (prevEnd !== null && it.x - prevEnd > it.size * 0.12 && !/\s$/.test(text) && !/^\s/.test(it.str)) {
          text += " ";
          map.push(null);
        }
        Array.from(it.str).forEach((ch, i) => { text += ch; map.push({ run: it, i }); });
        prevEnd = it.x + it.w;
      }
      out.push({ text, map, rot });
    }
  }
  return out;
}

/** Find personal data (and/or a custom search) in a page's text runs. */
export function findInRuns(runs: TextRun[], kinds: PiiKind[], custom?: string): PiiMatch[] {
  const pats = patterns(kinds, custom);
  if (!pats.length) return [];
  const out: PiiMatch[] = [];
  const bounds = new Map<Run, number[]>();
  for (const line of lines(runs)) {
    const taken: Array<[number, number]> = [];
    for (const p of pats) {
      p.re.lastIndex = 0;
      for (const m of line.text.matchAll(p.re)) {
        const s = m.index!, e = s + m[0].length;
        if (taken.some(([a, b]) => s < b && a < e)) continue;
        if (p.ok && !p.ok(m[0], line.text)) continue;
        taken.push([s, e]);
        let x0 = Infinity, x1 = -Infinity, y = 0, size = 0;
        for (let k = s; k < e; k++) {
          const at = line.map[k];
          if (!at) continue;
          let b = bounds.get(at.run);
          if (!b) bounds.set(at.run, (b = boundaries(at.run)));
          x0 = Math.min(x0, b[at.i]!);
          x1 = Math.max(x1, b[at.i + 1]!);
          y = at.run.y;
          size = Math.max(size, at.run.size);
        }
        if (!Number.isFinite(x0)) continue;
        const pad = size * 0.08;
        const frame: Rect = { x: x0 - pad, y: y - size * 0.3, w: x1 - x0 + 2 * pad, h: size * 1.25 };
        const r = rectFromTextFrame(line.rot, frame);
        const r2 = (v: number) => Math.round(v * 100) / 100;
        out.push({ kind: p.kind, text: m[0], rect: { x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h) } });
      }
    }
  }
  return out;
}
