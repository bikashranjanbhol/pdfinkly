"use client";

import type { PDFPageProxy } from "pdfjs-dist";
import { OCR_FONT_NAME, rectFromTextFrame, textRotation, toTextFrame, type Rect } from "@pdfinkly/shared";

/** One run of same-font text on one baseline (in the block's text frame). */
export interface TextLine {
  text: string;
  x: number;
  x1: number;
  baseline: number;
}

/** A paragraph of existing PDF text that can be edited as one block. */
export interface TextBlock {
  key: string;
  lines: TextLine[];
  /** Box from the first line's ascender to the last line's descender (PDF space). */
  rect: Rect;
  /**
   * Direction of the text, degrees counter-clockwise in PDF space (0 = normal,
   * 90 = runs up the unrotated page, i.e. upright on a page shown rotated 90°).
   * `firstBaseline` and `lineHeight` are measured in that direction.
   */
  rotation: 0 | 90 | 180 | 270;
  /** Per-line boxes whose glyphs get removed on save. */
  cover: Rect[];
  text: string;
  size: number;
  lineHeight: number;
  /** Distance from rect top to the first baseline. */
  firstBaseline: number;
  font: {
    raw: string; // e.g. "BAAAAA+Carlito-Bold"
    embedded: boolean;
    serif: boolean;
    mono: boolean;
  };
}

interface Item { str: string; x: number; y: number; w: number; size: number; font: string; rot: 0 | 90 | 180 | 270 }

type FontObj = { name?: string; isSerifFont?: boolean; isMonospace?: boolean; missingFile?: boolean };

const cache = new WeakMap<PDFPageProxy, Promise<TextBlock[]>>();

/** Paragraph-level text blocks of a page (cached per page proxy). */
export function textBlocks(page: PDFPageProxy): Promise<TextBlock[]> {
  let p = cache.get(page);
  if (!p) {
    p = extract(page).catch(() => []);
    cache.set(page, p);
  }
  return p;
}

async function extract(page: PDFPageProxy): Promise<TextBlock[]> {
  // The operator list loads the page's fonts into commonObjs, where their real names live.
  await page.getOperatorList();
  const tc = await page.getTextContent();
  const styles = tc.styles as Record<string, { ascent?: number; descent?: number }>;
  // In the browser PDF.js registers each font only after its font face has loaded,
  // so wait for it (briefly) instead of reading it straight away.
  const objs = page.commonObjs as unknown as { get(id: string, cb: (d: unknown) => void, err: () => void): void };
  const fontCache = new Map<string, Promise<FontObj | null>>();
  const fontInfo = (name: string): Promise<FontObj | null> => {
    let p = fontCache.get(name);
    if (!p) {
      p = new Promise<FontObj | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 3000);
        try {
          objs.get(name, (d) => { clearTimeout(t); resolve(d as FontObj); }, () => { clearTimeout(t); resolve(null); });
        } catch {
          clearTimeout(t);
          resolve(null);
        }
      });
      fontCache.set(name, p);
    }
    return p;
  };

  const items: Item[] = [];
  for (const raw of tc.items as Array<{ str?: string; transform?: number[]; width?: number; fontName?: string }>) {
    const t = raw.transform;
    if (!raw.str || !t || !raw.fontName) continue;
    // Axis-aligned text in any of the four directions (skewed text isn't editable).
    const rot = textRotation(t[0]!, t[1]!, t[2]!, t[3]!);
    if (rot === null || !raw.str.trim()) continue;
    // Work in the text's own frame, where it runs left to right with y up.
    const [x, y] = toTextFrame(rot, t[4]!, t[5]!);
    items.push({ str: raw.str, x, y, w: raw.width ?? 0, size: Math.hypot(t[2]!, t[3]!), font: raw.fontName, rot });
  }

  const blocks: TextBlock[] = [];
  for (const rot of [0, 90, 180, 270] as const) {
    const mine = items.filter((i) => i.rot === rot);
    if (mine.length) blocks.push(...(await group(mine, rot, styles, fontInfo)));
  }
  return blocks;
}

async function group(
  items: Item[],
  rot: 0 | 90 | 180 | 270,
  styles: Record<string, { ascent?: number; descent?: number }>,
  fontInfo: (name: string) => Promise<FontObj | null>,
): Promise<TextBlock[]> {

  const fonts = new Map<string, FontObj | null>();
  await Promise.all([...new Set(items.map((i) => i.font))].map(async (n) => fonts.set(n, await fontInfo(n))));
  // Recognised (OCR) text gets a size per line from the scan, so sizes within a
  // paragraph wobble by a few percent; real fonts are exact.
  const sameSize = (font: string, a: number, b: number) =>
    Math.abs(a - b) <= (fonts.get(font)?.name === OCR_FONT_NAME ? Math.max(0.2, Math.max(a, b) * 0.08) : 0.2);

  // 1) Rows: cluster by baseline.
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Item[][] = [];
  for (const it of items) {
    const row = rows.find((r) => Math.abs(r[0]!.y - it.y) < Math.max(0.5, it.size * 0.12));
    if (row) row.push(it);
    else rows.push([it]);
  }

  // 2) Segments: within a row, split on font changes and wide gaps (columns, tabs).
  type Seg = TextLine & { size: number; font: string };
  const segs: Seg[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let cur: Seg | null = null;
    for (const it of row) {
      const gap = cur ? it.x - cur.x1 : 0;
      if (cur && cur.font === it.font && sameSize(it.font, cur.size, it.size) && gap < it.size * 0.9 && gap > -it.size * 0.3) {
        const needSpace = gap > it.size * 0.12 && !cur.text.endsWith(" ") && !it.str.startsWith(" ");
        cur.text += (needSpace ? " " : "") + it.str;
        cur.x1 = Math.max(cur.x1, it.x + it.w);
      } else {
        cur = { text: it.str, x: it.x, x1: it.x + it.w, baseline: it.y, size: it.size, font: it.font };
        segs.push(cur);
      }
    }
  }

  // 3) Blocks: stack segments that share font, size and left edge, with steady line spacing.
  segs.sort((a, b) => b.baseline - a.baseline || a.x - b.x);
  type Draft = { lines: Seg[]; gap: number | null };
  const drafts: Draft[] = [];
  for (const s of segs) {
    const fit = drafts.find((d) => {
      const last = d.lines[d.lines.length - 1]!;
      const first = d.lines[0]!;
      const dy = last.baseline - s.baseline;
      if (last.font !== s.font || !sameSize(s.font, last.size, s.size)) return false;
      if (Math.abs(first.x - s.x) > s.size * 0.6) return false;
      if (dy < s.size * 0.9 || dy > s.size * 1.9) return false;
      if (d.gap !== null && Math.abs(dy - d.gap) > d.gap * 0.25) return false;
      return true;
    });
    if (fit) {
      fit.gap ??= fit.lines[fit.lines.length - 1]!.baseline - s.baseline;
      fit.lines.push(s);
    } else drafts.push({ lines: [s], gap: null });
  }


  return drafts.map((d) => {
    const first = d.lines[0]!;
    const st = styles[first.font] ?? {};
    const ascent = clamp(st.ascent ?? 0.9, 0.6, 1.2);
    const descent = clamp(Math.abs(st.descent ?? 0.25), 0.1, 0.5);
    const size = first.size;
    const left = Math.min(...d.lines.map((l) => l.x));
    const right = Math.max(...d.lines.map((l) => l.x1));
    const top = first.baseline + ascent * size;
    const bottom = d.lines[d.lines.length - 1]!.baseline - descent * size;
    const f = fonts.get(first.font) ?? null;
    // OCR text sits over a scanned image whose lines may be slightly tilted: cover a bit more.
    const ocr = f?.name === OCR_FONT_NAME;
    const padY = ocr ? size * 0.2 : 0;
    const padX = ocr ? size * 0.1 : 0;
    const back = (r: Rect): Rect => {
      const p = rectFromTextFrame(rot, r);
      return { x: r2(p.x), y: r2(p.y), w: r2(p.w), h: r2(p.h) };
    };
    return {
      key: `${rot}:${Math.round(left)}:${Math.round(first.baseline)}`,
      lines: d.lines.map(({ text, x, x1, baseline }) => ({ text, x, x1, baseline })),
      rect: back({ x: left, y: bottom, w: right - left, h: top - bottom }),
      rotation: rot,
      cover: d.lines.map((l) => back({ x: l.x - padX, y: l.baseline - descent * size - padY, w: l.x1 - l.x + padX * 2, h: (ascent + descent) * size + padY * 2 })),
      text: d.lines.map((l) => l.text).join("\n"),
      size: r2(size),
      lineHeight: r2(d.gap ?? size * 1.2),
      firstBaseline: r2(ascent * size),
      font: {
        raw: f?.name ?? first.font,
        embedded: f ? !f.missingFile : true,
        serif: !!f?.isSerifFont,
        mono: !!f?.isMonospace,
      },
    };
  });
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/* ------------------------------------------------------------- colours */

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/**
 * Read the text colour and the background colour of a block from the rendered
 * page canvas: background = the most common colour, text = the average of the
 * pixels furthest from it.
 */
export function sampleColors(canvas: HTMLCanvasElement, css: { left: number; top: number; width: number; height: number }, cssWidth: number): { fg: string; bg: string } {
  const fallback = { fg: "#000000", bg: "#FFFFFF" };
  try {
    const k = canvas.width / cssWidth;
    const x = Math.max(0, Math.floor(css.left * k));
    const y = Math.max(0, Math.floor(css.top * k));
    const w = Math.min(canvas.width - x, Math.ceil(css.width * k));
    const h = Math.min(canvas.height - y, Math.ceil(css.height * k));
    if (w <= 0 || h <= 0) return fallback;
    const data = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(x, y, w, h).data;
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const q = ((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4);
      counts.set(q, (counts.get(q) ?? 0) + 1);
    }
    let bgQ = 0, best = -1;
    for (const [q, c] of counts) if (c > best) { best = c; bgQ = q; }
    // Average the exact pixels in the winning bucket for the background.
    let br = 0, bgG = 0, bb = 0, bn = 0;
    const dist: Array<[number, number]> = [];
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      const q = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      if (q === bgQ) { br += r; bgG += g; bb += b; bn++; }
    }
    const bg: [number, number, number] = bn ? [br / bn, bgG / bn, bb / bn] : [255, 255, 255];
    for (let i = 0; i < data.length; i += 4) {
      const d = Math.abs(data[i]! - bg[0]) + Math.abs(data[i + 1]! - bg[1]) + Math.abs(data[i + 2]! - bg[2]);
      dist.push([d, i]);
    }
    dist.sort((a, b) => b[0] - a[0]);
    const top = dist.slice(0, Math.max(1, Math.floor(dist.length * 0.04))).filter(([d]) => d > 60);
    if (top.length === 0) return { fg: bg[0] + bg[1] + bg[2] > 382 ? "#000000" : "#FFFFFF", bg: toHex(...bg) };
    let fr = 0, fg = 0, fb = 0;
    for (const [, i] of top) { fr += data[i]!; fg += data[i + 1]!; fb += data[i + 2]!; }
    return { fg: toHex(fr / top.length, fg / top.length, fb / top.length), bg: toHex(...bg) };
  } catch {
    return fallback;
  }
}
