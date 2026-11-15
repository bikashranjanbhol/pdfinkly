"use client";

import { fromTextFrame, matchFont, OCR_FONT_NAME, type Face } from "@pdfinkly/shared";
import type { PDFPageProxy } from "pdfjs-dist";
import { makeGeom, toCss, type PageGeom } from "@/components/editor/geometry";
import { sampleColors, textBlocks } from "@/components/editor/textBlocks";

/**
 * A page's content in reading order, in the page's *visual* frame (points, origin
 * top-left, as displayed after rotation), for rebuilding it as Word, PowerPoint
 * or Excel. Paragraphs come from the same detection the Edit text tool uses,
 * with runs of different fonts on one line kept together.
 */

export interface Run {
  text: string;
  family: string;
  size: number;
  bold: boolean;
  italic: boolean;
  color: string; // #RRGGBB
}

export interface Para {
  x: number;
  top: number;
  bottom: number;
  width: number;
  /** Largest font size in the paragraph. */
  size: number;
  /** Distance between baselines (0 for one line). */
  lineGap: number;
  lines: number;
  runs: Run[];
  /** Left positions (from the paragraph's x) where a tab jumps to, for gaps inside a line. */
  tabs: number[];
}

export interface Picture { x: number; top: number; w: number; h: number; data: Uint8Array; type: "png" | "jpg" }

/** A single run of text as PDF.js reports it, for table detection. */
export interface Cellish { text: string; x: number; x1: number; baseline: number; size: number }

export interface PageLayout {
  width: number;
  height: number;
  paras: Para[];
  pictures: Picture[];
  cells: Cellish[];
  /** Whether the page has no real text (a scan). */
  scanned: boolean;
}

/** Office font family for a PDF font. */
export function officeFamily(raw: string): { family: string; bold: boolean; italic: boolean } {
  if (raw === OCR_FONT_NAME) return { family: "Calibri", bold: false, italic: false };
  const m = matchFont(raw);
  const byFace: Record<Face, string> = { Carlito: "Calibri", Caladea: "Cambria", Helvetica: "Arial", TimesRoman: "Times New Roman", Courier: "Courier New" };
  const fam = m.family.replace(/\s*(MT|PS|Std|Pro|LT)$/i, "").trim();
  // Keep a real family name (Word substitutes if it's missing); generic or garbled names map to a face.
  const generic = !fam || /^(g_|f\d|font|t\d|tt\d|c\d)/i.test(fam) || fam.length < 3;
  const family = generic ? byFace[m.face] : /^calibri|carlito/i.test(fam) ? "Calibri" : /^cambria|caladea/i.test(fam) ? "Cambria" : /helvetica/i.test(fam) ? "Arial" : /times/i.test(fam) ? "Times New Roman" : /courier/i.test(fam) ? "Courier New" : fam;
  return { family, bold: m.bold, italic: m.italic };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

async function render(page: PDFPageProxy, scale: number): Promise<HTMLCanvasElement> {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport: vp }).promise;
  return canvas;
}

const toBytes = async (canvas: HTMLCanvasElement, type: "png" | "jpg") =>
  new Uint8Array(await (await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), type === "png" ? "image/png" : "image/jpeg", 0.88))).arrayBuffer());

/** Image placements on the page (visual frame), from the operator list. */
async function imageBoxes(page: PDFPageProxy, g: PageGeom): Promise<Array<{ x: number; top: number; w: number; h: number }>> {
  const { OPS } = await import("pdfjs-dist");
  const ops = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const mul = (m: number[], n: number[]) => [
    m[0]! * n[0]! + m[1]! * n[2]!, m[0]! * n[1]! + m[1]! * n[3]!,
    m[2]! * n[0]! + m[3]! * n[2]!, m[2]! * n[1]! + m[3]! * n[3]!,
    m[4]! * n[0]! + m[5]! * n[2]! + n[4]!, m[4]! * n[1]! + m[5]! * n[3]! + n[5]!,
  ];
  const out: Array<{ x: number; top: number; w: number; h: number }> = [];
  ops.fnArray.forEach((fn, i) => {
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ops.argsArray[i] as number[], ctm);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => toCss(g, ctm[0]! * u! + ctm[2]! * v! + ctm[4]!, ctm[1]! * u! + ctm[3]! * v! + ctm[5]!));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const x = Math.max(0, Math.min(...xs)), top = Math.max(0, Math.min(...ys));
      const w = Math.min(g.width, Math.max(...xs)) - x, h = Math.min(g.height, Math.max(...ys)) - top;
      if (w > 1 && h > 1) out.push({ x, top, w, h });
    }
  });
  return out;
}

/** Lay out one page. `pictures`: also crop the page's images (for Word). */
export async function pageLayout(page: PDFPageProxy, opts: { pictures: boolean }): Promise<PageLayout> {
  const rotation = ((page.rotate % 360) + 360) % 360;
  const g = makeGeom(page.view as [number, number, number, number], rotation, 1);
  const scale = 2; // render at 144 dpi: colours and picture crops
  const canvas = await render(page, scale);
  const blocks = (await textBlocks(page)).filter((b) => b.rotation === rotation);

  // Segments: one line of one block, with its style and colour, in visual coordinates.
  interface Seg { block: number; text: string; x: number; x1: number; base: number; run: Omit<Run, "text"> }
  const segs: Seg[] = [];
  blocks.forEach((b, bi) => {
    const style = officeFamily(b.font.raw);
    const css = { left: 0, top: 0, width: 0, height: 0 };
    const c0 = toCss(g, ...fromTextFrame(rotation, b.lines[0]!.x, b.lines[0]!.baseline));
    css.left = c0[0] * scale; css.top = (c0[1] - b.size * 0.8) * scale; css.width = (b.lines[0]!.x1 - b.lines[0]!.x) * scale; css.height = b.size * scale;
    const color = sampleColors(canvas, css, canvas.width).fg;
    for (const l of b.lines) {
      const [x, base] = toCss(g, ...fromTextFrame(rotation, l.x, l.baseline));
      segs.push({ block: bi, text: l.text, x, x1: x + (l.x1 - l.x), base, run: { ...style, size: r1(b.size), color } });
    }
  });

  // Rows: segments sharing a baseline.
  segs.sort((a, b) => a.base - b.base || a.x - b.x);
  const rows: Seg[][] = [];
  for (const s of segs) {
    const row = rows.find((r) => Math.abs(r[0]!.base - s.base) < Math.max(1, s.run.size * 0.35));
    if (row) row.push(s);
    else rows.push([s]);
  }
  rows.forEach((r) => r.sort((a, b) => a.x - b.x));
  rows.sort((a, b) => a[0]!.base - b[0]!.base);

  // Paragraphs: consecutive rows that continue the same detected block.
  const paras: Para[] = [];
  let cur: { rows: Seg[][]; blocks: Set<number> } | null = null;
  const flush = () => {
    if (!cur) return;
    const first = cur.rows[0]!, last = cur.rows[cur.rows.length - 1]!;
    const size = Math.max(...cur.rows.flat().map((s) => s.run.size));
    const x = Math.min(...first.map((s) => s.x));
    const runs: Run[] = [];
    const tabs: number[] = [];
    const push = (text: string, style: Omit<Run, "text">) => {
      const prev = runs[runs.length - 1];
      if (prev && prev.family === style.family && prev.size === style.size && prev.bold === style.bold && prev.italic === style.italic && prev.color === style.color) prev.text += text;
      else runs.push({ text, ...style });
    };
    cur.rows.forEach((row, ri) => {
      if (ri > 0) {
        const prev = runs[runs.length - 1];
        // Re-join words hyphenated at the end of a line.
        if (prev && /[a-z]-$/.test(prev.text) && /^[a-z]/.test(row[0]!.text)) prev.text = prev.text.slice(0, -1);
        else push(" ", row[0]!.run);
      }
      row.forEach((s, si) => {
        if (si > 0) {
          const gap = s.x - row[si - 1]!.x1;
          if (gap > s.run.size * 1.5 && cur!.rows.length === 1) {
            push("\t", s.run);
            tabs.push(r1(s.x - x));
          } else if (gap > s.run.size * 0.12 && !/\s$/.test(row[si - 1]!.text) && !/^\s/.test(s.text)) push(" ", s.run);
        }
        push(s.text, s.run);
      });
    });
    const bases = cur.rows.map((r) => r[0]!.base);
    paras.push({
      x: r1(x), top: r1(first[0]!.base - size * 0.8), bottom: r1(last[0]!.base + size * 0.25),
      width: r1(Math.max(...cur.rows.flat().map((s) => s.x1)) - x), size,
      lineGap: bases.length > 1 ? r1((bases[bases.length - 1]! - bases[0]!) / (bases.length - 1)) : 0,
      lines: cur.rows.length, runs, tabs,
    });
    cur = null;
  };
  for (const row of rows) {
    const keys = new Set(row.map((s) => s.block));
    const prevRow = cur?.rows[cur.rows.length - 1];
    const continues = cur && [...keys].some((k) => cur!.blocks.has(k)) && prevRow && row[0]!.base - prevRow[0]!.base < row[0]!.run.size * 2;
    if (!continues) {
      flush();
      cur = { rows: [], blocks: new Set() };
    }
    cur!.rows.push(row);
    keys.forEach((k) => cur!.blocks.add(k));
  }
  flush();

  // Pictures: crops of the rendered page where images are drawn (skipping tiny ones and a full-page scan).
  const pictures: Picture[] = [];
  const scanned = blocks.length === 0 || blocks.every((b) => b.font.raw === OCR_FONT_NAME);
  if (opts.pictures) {
    for (const box of await imageBoxes(page, g)) {
      if (box.w < 24 || box.h < 24) continue;
      if (scanned && box.w * box.h > g.width * g.height * 0.6 && paras.length) continue; // OCR'd scan: the text replaces the image
      const c = document.createElement("canvas");
      c.width = Math.round(box.w * scale);
      c.height = Math.round(box.h * scale);
      c.getContext("2d")!.drawImage(canvas, box.x * scale, box.top * scale, c.width, c.height, 0, 0, c.width, c.height);
      const type = box.w * box.h > 40_000 ? "jpg" : "png";
      pictures.push({ ...box, data: await toBytes(c, type), type });
      c.width = c.height = 0;
    }
  }

  // Raw runs for table detection.
  const cells: Cellish[] = [];
  const tc = await page.getTextContent();
  for (const it of tc.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
    if (!it.str?.trim() || !it.transform) continue;
    const t = it.transform;
    const size = Math.hypot(t[2]!, t[3]!) || 1;
    const [x, base] = toCss(g, t[4]!, t[5]!);
    const [x2] = toCss(g, t[4]! + (t[0]! / (Math.hypot(t[0]!, t[1]!) || 1)) * (it.width ?? 0), t[5]! + (t[1]! / (Math.hypot(t[0]!, t[1]!) || 1)) * (it.width ?? 0));
    if (Math.abs(x2 - x) < 0.01 && (it.width ?? 0) > 0.5) continue; // not horizontal as displayed
    cells.push({ text: it.str.trim(), x: Math.min(x, x2), x1: Math.max(x, x2), baseline: base, size });
  }

  canvas.width = canvas.height = 0;
  return { width: g.width, height: g.height, paras, pictures, cells, scanned };
}

/** Render a page (visual orientation) to an image, e.g. for slides or page images. */
export async function pageImage(page: PDFPageProxy, dpi: number, type: "png" | "jpg"): Promise<{ data: Uint8Array; width: number; height: number }> {
  const canvas = await render(page, dpi / 72);
  const out = { data: await toBytes(canvas, type), width: canvas.width, height: canvas.height };
  canvas.width = canvas.height = 0;
  return out;
}
