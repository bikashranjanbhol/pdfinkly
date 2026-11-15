/**
 * Minimal PDF content-stream reader/writer for one job: find where every text
 * glyph lands on the page and remove the ones inside given rectangles, without
 * moving anything else.
 *
 * Removal never deletes a text-showing operator outright. It rewrites the
 * operator as a TJ array in which each removed glyph becomes a numeric
 * adjustment equal to that glyph's advance, so the glyphs after it (and any
 * later text that relies on the current text position) stay exactly in place.
 *
 * Supported: Tj, TJ, ', " with simple fonts (1-byte codes) and Type0 fonts
 * (Identity-H and other 2-byte CMaps; 1-byte embedded CMaps), q/Q, cm, BT/ET,
 * Td/TD/Tm/T*, Tc/Tw/Tz/TL/Ts/Tf, inline images.
 * Not supported (left untouched, reported via counts): text inside Form
 * XObjects, vertical writing (Identity-V), Type3 fonts with skewed matrices.
 */

/* ------------------------------------------------------------- lexer */

export type Operand =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "str"; v: Uint8Array }
  | { t: "arr"; v: Operand[] }
  | { t: "dict" }
  | { t: "kw"; v: string }; // true / false / null

export interface Op {
  op: string;
  args: Operand[];
  /** Byte range [start, end) of the whole operation (operands + operator) in the source. */
  start: number;
  end: number;
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ( ) < > [ ] { } / %
const isRegular = (b: number) => !WS.has(b) && !DELIM.has(b);

export function parseContent(src: Uint8Array): Op[] {
  const ops: Op[] = [];
  let i = 0;
  const n = src.length;
  let stack: Operand[] = [];
  let opStart = -1;

  const skipWs = () => {
    for (;;) {
      while (i < n && WS.has(src[i]!)) i++;
      if (i < n && src[i] === 37) { // % comment
        while (i < n && src[i] !== 10 && src[i] !== 13) i++;
        continue;
      }
      return;
    }
  };

  const readLiteral = (): Uint8Array => {
    i++; // (
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      const c = src[i++]!;
      if (c === 92) { // backslash
        const e = src[i++]!;
        if (e === 110) out.push(10);
        else if (e === 114) out.push(13);
        else if (e === 116) out.push(9);
        else if (e === 98) out.push(8);
        else if (e === 102) out.push(12);
        else if (e === 40 || e === 41 || e === 92) out.push(e);
        else if (e === 13) { if (src[i] === 10) i++; } // line continuation
        else if (e === 10) { /* line continuation */ }
        else if (e >= 48 && e <= 55) {
          let v = e - 48;
          for (let k = 0; k < 2 && src[i]! >= 48 && src[i]! <= 55; k++) v = v * 8 + (src[i++]! - 48);
          out.push(v & 255);
        } else out.push(e);
      } else if (c === 40) { depth++; out.push(c); }
      else if (c === 41) { if (--depth === 0) break; out.push(c); }
      else out.push(c);
    }
    return Uint8Array.from(out);
  };

  const readHex = (): Uint8Array => {
    i++; // <
    const digits: number[] = [];
    while (i < n && src[i] !== 62) {
      const c = src[i++]!;
      const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (v >= 0) digits.push(v);
    }
    i++; // >
    if (digits.length % 2) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = (digits[2 * k]! << 4) | digits[2 * k + 1]!;
    return out;
  };

  const readToken = (): Operand | { t: "op"; v: string } | { t: "close"; v: string } | null => {
    skipWs();
    if (i >= n) return null;
    const c = src[i]!;
    if (c === 40) return { t: "str", v: readLiteral() };
    if (c === 60) {
      if (src[i + 1] === 60) { skipDict(); return { t: "dict" }; }
      return { t: "str", v: readHex() };
    }
    if (c === 91) { i++; const items: Operand[] = []; for (;;) { const tk = readToken(); if (!tk || (tk.t === "close" && tk.v === "]")) break; if (tk.t !== "op" && tk.t !== "close") items.push(tk); } return { t: "arr", v: items }; }
    if (c === 93) { i++; return { t: "close", v: "]" }; }
    if (c === 62 || c === 41 || c === 123 || c === 125) { i++; return { t: "close", v: String.fromCharCode(c) }; }
    if (c === 47) {
      i++;
      const s = i;
      while (i < n && isRegular(src[i]!)) i++;
      return { t: "name", v: latin1(src.subarray(s, i)) };
    }
    const s = i;
    while (i < n && isRegular(src[i]!)) i++;
    if (s === i) { i++; return readToken(); } // stray delimiter
    const word = latin1(src.subarray(s, i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: "num", v: Number(word) };
    if (word === "true" || word === "false" || word === "null") return { t: "kw", v: word };
    return { t: "op", v: word };
  };

  function skipDict() {
    i += 2; // <<
    let depth = 1;
    while (i < n && depth > 0) {
      const c = src[i]!;
      if (c === 40) { readLiteral(); continue; }
      if (c === 60 && src[i + 1] === 60) { depth++; i += 2; continue; }
      if (c === 62 && src[i + 1] === 62) { depth--; i += 2; continue; }
      if (c === 60) { readHex(); continue; }
      i++;
    }
  }

  for (;;) {
    skipWs();
    if (i >= n) break;
    const tokStart = i;
    const tk = readToken();
    if (!tk) break;
    if (opStart < 0) opStart = tokStart;
    if (tk.t === "close") continue;
    if (tk.t !== "op") { stack.push(tk); continue; }
    if (tk.v === "BI") {
      // Inline image: skip the dictionary, "ID", one whitespace byte, then data up to "EI".
      const idAt = findKeyword(src, i, "ID");
      let j = idAt < 0 ? n : idAt + 3;
      let end = n;
      for (; j < n - 1; j++) {
        if (src[j] === 69 && src[j + 1] === 73 && WS.has(src[j - 1]!) && (j + 2 >= n || WS.has(src[j + 2]!))) { end = j + 2; break; }
      }
      i = end;
      ops.push({ op: "BI", args: [], start: opStart, end: i });
    } else {
      ops.push({ op: tk.v, args: stack, start: opStart, end: i });
    }
    stack = [];
    opStart = -1;
  }
  return ops;
}

function findKeyword(src: Uint8Array, from: number, kw: string): number {
  const a = kw.charCodeAt(0), b = kw.charCodeAt(1);
  for (let j = from; j < src.length - 1; j++) {
    if (src[j] === a && src[j + 1] === b && (j === 0 || WS.has(src[j - 1]!)) && (j + 2 >= src.length || WS.has(src[j + 2]!))) return j;
  }
  return -1;
}

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let k = 0; k < b.length; k++) s += String.fromCharCode(b[k]!);
  return s;
};

/* ------------------------------------------------------------- fonts */

export interface FontMetrics {
  /** 1 for simple fonts, 2 for most Type0 fonts. */
  bytesPerCode: 1 | 2;
  /** Glyph advance in thousandths of text space. */
  width(code: number): number;
  /** Vertical writing isn't supported for removal. */
  vertical: boolean;
}

export type FontResolver = (resourceName: string) => FontMetrics | null;

/* ------------------------------------------------------------ geometry */

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const ID: M = [1, 0, 0, 1, 0, 0];

export interface Box { x: number; y: number; w: number; h: number }

export interface Glyph {
  /** Index of the op in the parsed list. */
  opIndex: number;
  /** Centre of the glyph in user space. */
  cx: number;
  cy: number;
  code: number;
}

interface TextState { Tc: number; Tw: number; Th: number; TL: number; Ts: number; Tr: number; font: string | null; size: number }

/**
 * Walk the content stream, calling `onShow` for every text-showing op with the
 * glyph positions it produces. Returns nothing; callers collect what they need.
 */
function interpret(ops: Op[], fonts: FontResolver, onShow: (opIndex: number, glyphs: Array<{ code: number; bytes: Uint8Array; cx: number; cy: number; adv: number; isSpace: boolean; seg: number }>, ts: TextState, metrics: FontMetrics | null) => void) {
  let ctm: M = [...ID];
  let ts: TextState = { Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0, Tr: 0, font: null, size: 0 };
  const stack: Array<{ ctm: M; ts: TextState }> = [];
  let Tm: M = [...ID];
  let Tlm: M = [...ID];
  const num = (o: Operand | undefined) => (o && o.t === "num" ? o.v : 0);

  const nextLine = () => {
    Tlm = mul([1, 0, 0, 1, 0, -ts.TL], Tlm);
    Tm = [...Tlm];
  };

  const show = (opIndex: number, parts: Operand[]) => {
    const metrics = ts.font ? fonts(ts.font) : null;
    const glyphs: Array<{ code: number; bytes: Uint8Array; cx: number; cy: number; adv: number; isSpace: boolean; seg: number }> = [];
    parts.forEach((part, seg) => {
      if (part.t === "num") {
        Tm = mul([1, 0, 0, 1, (-part.v / 1000) * ts.size * ts.Th, 0], Tm);
        return;
      }
      if (part.t !== "str" || !metrics) return;
      const bpc = metrics.bytesPerCode;
      for (let k = 0; k + bpc <= part.v.length; k += bpc) {
        const code = bpc === 2 ? (part.v[k]! << 8) | part.v[k + 1]! : part.v[k]!;
        const w0 = metrics.width(code) / 1000;
        const isSpace = bpc === 1 && code === 32;
        const glyphAdv = w0 * ts.size * ts.Th;
        const trm = mul([1, 0, 0, 1, 0, ts.Ts], mul(Tm, ctm));
        const [cx, cy] = apply(trm, glyphAdv / 2, ts.size * 0.35);
        const adv = (w0 * ts.size + ts.Tc + (isSpace ? ts.Tw : 0)) * ts.Th;
        glyphs.push({ code, bytes: part.v.subarray(k, k + bpc), cx, cy, adv, isSpace, seg });
        Tm = mul([1, 0, 0, 1, adv, 0], Tm);
      }
    });
    onShow(opIndex, glyphs, { ...ts }, metrics);
  };

  ops.forEach((o, idx) => {
    const a = o.args;
    switch (o.op) {
      case "q": stack.push({ ctm: [...ctm] as M, ts: { ...ts } }); break;
      case "Q": { const s = stack.pop(); if (s) { ctm = s.ctm; ts = s.ts; } break; }
      case "cm": ctm = mul([num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])], ctm); break;
      case "BT": Tm = [...ID]; Tlm = [...ID]; break;
      case "Tc": ts.Tc = num(a[0]); break;
      case "Tw": ts.Tw = num(a[0]); break;
      case "Tz": ts.Th = num(a[0]) / 100; break;
      case "TL": ts.TL = num(a[0]); break;
      case "Ts": ts.Ts = num(a[0]); break;
      case "Tr": ts.Tr = num(a[0]); break;
      case "Tf": ts.font = a[0]?.t === "name" ? a[0].v : null; ts.size = num(a[1]); break;
      case "Td": Tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], Tlm); Tm = [...Tlm]; break;
      case "TD": ts.TL = -num(a[1]); Tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], Tlm); Tm = [...Tlm]; break;
      case "Tm": Tlm = [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])]; Tm = [...Tlm]; break;
      case "T*": nextLine(); break;
      case "Tj": show(idx, a.slice(0, 1)); break;
      case "TJ": show(idx, a[0]?.t === "arr" ? a[0].v : []); break;
      case "'": nextLine(); show(idx, a.slice(0, 1)); break;
      case '"': ts.Tw = num(a[0]); ts.Tc = num(a[1]); nextLine(); show(idx, a.slice(2, 3)); break;
    }
  });
}

/** Every glyph on the page with its centre point, for tests and diagnostics. */
export function listGlyphs(ops: Op[], fonts: FontResolver): Glyph[] {
  const out: Glyph[] = [];
  interpret(ops, fonts, (opIndex, glyphs) => glyphs.forEach((g) => out.push({ opIndex, cx: g.cx, cy: g.cy, code: g.code })));
  return out;
}

const inside = (x: number, y: number, r: Box, tol: number) =>
  x >= r.x - tol && x <= r.x + r.w + tol && y >= r.y - tol && y <= r.y + r.h + tol;

export interface RemovalGroup { id: string; rects: Box[] }

/**
 * Remove glyphs whose centres fall inside any group's rects. Returns the new
 * content bytes (or null if nothing changed) and how many glyphs were removed
 * per group, so callers can tell when some text couldn't be found (e.g. it
 * lives in a Form XObject) and fall back to covering it.
 */
export function removeGlyphs(src: Uint8Array, fonts: FontResolver, groups: RemovalGroup[], tol = 0.75): { bytes: Uint8Array | null; removed: Record<string, number>; invisible: Record<string, number> } {
  const ops = parseContent(src);
  const removed: Record<string, number> = Object.fromEntries(groups.map((g) => [g.id, 0]));
  /** Removed glyphs that were invisible (render mode 3: an OCR layer over a scanned image). */
  const invisible: Record<string, number> = Object.fromEntries(groups.map((g) => [g.id, 0]));
  const rewrites = new Map<number, Uint8Array>();

  interpret(ops, fonts, (opIndex, glyphs, ts, metrics) => {
    if (!metrics || metrics.vertical || glyphs.length === 0 || ts.size === 0) return;
    const hit = glyphs.map((g) => {
      for (const grp of groups) for (const r of grp.rects) if (inside(g.cx, g.cy, r, tol)) return grp.id;
      return null;
    });
    if (hit.every((h) => h === null)) return;
    for (const h of hit) {
      if (!h) continue;
      removed[h] = (removed[h] ?? 0) + 1;
      if (ts.Tr === 3 || ts.Tr === 7) invisible[h] = (invisible[h] ?? 0) + 1;
    }

    // Rebuild as one TJ array: kept glyphs stay as strings, removed glyphs and
    // original kerning numbers become numeric adjustments.
    const o = ops[opIndex]!;
    const original = o.op === "TJ" && o.args[0]?.t === "arr" ? o.args[0].v : o.args.slice(o.op === '"' ? 2 : 0, o.op === '"' ? 3 : 1);
    const parts: Array<{ str: number[] } | { num: number }> = [];
    const pushNum = (v: number) => {
      const last = parts[parts.length - 1];
      if (last && "num" in last) last.num += v;
      else parts.push({ num: v });
    };
    const pushBytes = (b: Uint8Array) => {
      const last = parts[parts.length - 1];
      if (last && "str" in last) last.str.push(...b);
      else parts.push({ str: Array.from(b) });
    };
    let gi = 0;
    original.forEach((part, seg) => {
      if (part.t === "num") { pushNum(part.v); return; }
      if (part.t !== "str") return;
      while (gi < glyphs.length && glyphs[gi]!.seg === seg) {
        const g = glyphs[gi]!;
        if (hit[gi]) pushNum((-g.adv / ts.Th) * (1000 / ts.size));
        else pushBytes(g.bytes);
        gi++;
      }
    });
    const arr = parts
      .map((p) => ("num" in p ? fmt(p.num) : `<${p.str.map((b) => b.toString(16).padStart(2, "0")).join("")}>`))
      .join(" ");
    let text = `[${arr}] TJ`;
    if (o.op === "'") text = `T* ${text}`;
    if (o.op === '"') text = `${fmt(ts.Tw)} Tw ${fmt(ts.Tc)} Tc T* ${text}`;
    rewrites.set(opIndex, new TextEncoder().encode(text));
  });

  if (rewrites.size === 0) return { bytes: null, removed, invisible };
  const chunks: Uint8Array[] = [];
  let pos = 0;
  ops.forEach((o, idx) => {
    const r = rewrites.get(idx);
    if (!r) return;
    chunks.push(src.subarray(pos, o.start), r);
    pos = o.end;
  });
  chunks.push(src.subarray(pos));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return { bytes: out, removed, invisible };
}

const fmt = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};
