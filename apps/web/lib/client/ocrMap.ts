import type { OcrLine, OcrWord } from "@pdfinkly/shared";
import { makeGeom, toPdf } from "../../components/editor/geometry";

/** The parts of Tesseract's "blocks" output we use. */
export interface TBox { x0: number; y0: number; x1: number; y1: number }
export interface TWord { text: string; confidence: number; bbox: TBox }
export interface TLine {
  words: TWord[];
  bbox: TBox;
  baseline?: TBox | null;
  rowAttributes?: { rowHeight?: number; ascenders?: number; descenders?: number } | null;
}
export interface TBlock { paragraphs: Array<{ lines: TLine[] }> }

export interface MapOptions {
  /** Canvas pixels per PDF point the page was rendered at. */
  pxPerPt: number;
  /** page.view of the PDF page ([x0, y0, x1, y1]). */
  view: [number, number, number, number];
  /** Rotation the page was rendered with (its /Rotate, plus any turn applied for reading). */
  rotate: number;
  /** Words below this confidence are dropped (noise, stamps, photos). */
  minConfidence?: number;
}

/**
 * Convert Tesseract blocks (pixel boxes on the upright rendered page) into
 * text-layer lines in the page's unrotated PDF space.
 */
export function blocksToLines(blocks: TBlock[] | null | undefined, opts: MapOptions): OcrLine[] {
  const { pxPerPt: k, view, rotate } = opts;
  const minConf = opts.minConfidence ?? 35;
  const g = makeGeom(view, rotate, 1);
  const out: OcrLine[] = [];

  for (const block of blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        // Standalone punctuation is usually a speck of dirt; keep it only when Tesseract is sure.
        const words = (line.words ?? []).filter((w) => {
          const t = w.text.trim();
          if (!t || w.bbox.x1 <= w.bbox.x0) return false;
          return /[\p{L}\p{N}]/u.test(t) ? w.confidence >= minConf : w.confidence >= 85;
        });
        if (words.length === 0) continue;

        const bl = line.baseline;
        const hasBaseline = !!bl && bl.x1 > bl.x0 && Number.isFinite(bl.y0) && Number.isFinite(bl.y1);
        const baselineAt = (x: number, fallback: number) =>
          hasBaseline ? bl!.y0 + ((bl!.y1 - bl!.y0) * (x - bl!.x0)) / (bl!.x1 - bl!.x0) : fallback;

        // Font size: Tesseract's row height (x-height + ascenders + descenders) measures
        // 0.88–1.03 em across common faces (Calibri, Poppins, DejaVu Serif/Mono); ≈0.97 on average.
        const row = line.rowAttributes?.rowHeight ?? 0;
        const lineH = line.bbox.y1 - line.bbox.y0;
        const sizePx = row > 0 ? row / 0.97 : lineH / 1.2;
        const size = Math.max(2, Math.min(300, sizePx / k));

        const mapped: OcrWord[] = [];
        let dirX = 0, dirY = 0;
        for (const w of words) {
          const y0 = baselineAt(w.bbox.x0, w.bbox.y1);
          const y1 = baselineAt(w.bbox.x1, w.bbox.y1);
          const [px, py] = toPdf(g, w.bbox.x0 / k, y0 / k);
          const [qx, qy] = toPdf(g, w.bbox.x1 / k, y1 / k);
          const len = Math.hypot(qx - px, qy - py);
          if (!(len > 0)) continue;
          dirX += (qx - px) / len;
          dirY += (qy - py) / len;
          mapped.push({ text: w.text.trim().slice(0, 200), x: r3(px), y: r3(py), w: r3(len), size: r2(size) });
        }
        if (mapped.length === 0) continue;
        const n = Math.hypot(dirX, dirY) || 1;
        let dir: [number, number] = [dirX / n, dirY / n];

        // Scans are rarely perfectly straight. Lines within 3° of a page axis are snapped
        // onto it with one shared baseline, so they read as normal horizontal (or, on
        // rotated pages, vertical) text — which Edit text and text selection expect.
        const axis: [number, number] = Math.abs(dir[0]) >= Math.abs(dir[1]) ? [Math.sign(dir[0]), 0] : [0, Math.sign(dir[1])];
        const angle = Math.acos(Math.min(1, dir[0] * axis[0] + dir[1] * axis[1]));
        if (angle < (3 * Math.PI) / 180) {
          dir = axis;
          if (axis[1] === 0) {
            const y = mapped.reduce((s, w) => s + w.y * w.w, 0) / mapped.reduce((s, w) => s + w.w, 0);
            for (const w of mapped) w.y = r3(y);
          } else {
            const x = mapped.reduce((s, w) => s + w.x * w.w, 0) / mapped.reduce((s, w) => s + w.w, 0);
            for (const w of mapped) w.x = r3(x);
          }
        }
        out.push({ dir: [r3(dir[0]), r3(dir[1])], words: mapped.slice(0, 500) });
      }
    }
  }
  return out;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/* --------------------------------------------------------- orientation */

/** Mean word confidence (weighted by length) at or above which a page reads upright. */
export const UPRIGHT_CONFIDENCE = 65;

/**
 * How well Tesseract could read a page: the mean confidence of its words,
 * weighted by length (0–100), and how many words it found. Text read sideways
 * or upside down comes back as many short low-confidence fragments, so the
 * mean drops to ~20–40 while upright text scores ~90.
 */
export function readingConfidence(blocks: TBlock[] | null | undefined): { mean: number; words: number } {
  let chars = 0, sum = 0, words = 0;
  for (const b of blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const w of l.words ?? []) {
    const n = w.text.trim().length;
    if (!n) continue;
    words++;
    chars += n;
    sum += w.confidence * n;
  }
  return { mean: chars ? sum / chars : 0, words };
}

/**
 * Pick the clockwise turn (0, 90, 180 or 270) that makes a page readable, given
 * the confidence as rendered and when turned by each amount. Only turns when the
 * page reads poorly as it is and clearly better turned.
 */
export function pickTurn(current: number, turned: Partial<Record<90 | 180 | 270, number>>): 0 | 90 | 180 | 270 {
  if (current >= UPRIGHT_CONFIDENCE) return 0;
  let best: 0 | 90 | 180 | 270 = 0;
  let bestScore = current;
  for (const t of [90, 270, 180] as const) {
    const s = turned[t];
    if (s !== undefined && s > bestScore) { best = t; bestScore = s; }
  }
  return best && bestScore >= UPRIGHT_CONFIDENCE && bestScore - current >= 20 ? best : 0;
}
