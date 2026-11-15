"use client";

import type { PDFPageProxy } from "pdfjs-dist";
import type { OcrLine } from "@pdfinkly/shared";
import { blocksToLines, pickTurn, readingConfidence, UPRIGHT_CONFIDENCE, type TBlock } from "./ocrMap";
import { pdfjs } from "./pdf";

export type OcrLang = "eng" | "hin";

export const OCR_LANGS: Record<OcrLang, string> = { eng: "English", hin: "Hindi (हिन्दी)" };

export interface OcrProgress {
  /** 0-based index of the page being processed, among the selected pages. */
  page: number;
  total: number;
  /** Overall progress 0..1. */
  fraction: number;
  status: "loading" | "rendering" | "recognising" | "orienting" | "done";
}

export interface OcrPageInput {
  ref: string;
  page: PDFPageProxy;
  /** Rotation added in the editor on top of the page's own /Rotate. */
  rotation: number;
  /** The page is a scan (even if an earlier OCR run gave it a text layer). Detected when omitted. */
  scanned?: boolean;
}

export interface OcrResult {
  lines: Record<string, OcrLine[]>;
  /** Clockwise turns that make sideways or upside-down pages read upright. */
  turns: Record<string, 90 | 180 | 270>;
}

/** Pages with fewer extractable characters than this are treated as scans. */
const SCAN_TEXT_THRESHOLD = 20;

/** Characters of real text on a page (0 for scans). */
export async function textCharCount(page: PDFPageProxy): Promise<number> {
  const tc = await page.getTextContent();
  return (tc.items as Array<{ str?: string }>).reduce((n, i) => n + (i.str?.replace(/\s/g, "").length ?? 0), 0);
}

export const looksScanned = async (page: PDFPageProxy) => (await textCharCount(page)) < SCAN_TEXT_THRESHOLD;

/**
 * Pixels per PDF point of the largest image painted on the page (a scan's native
 * resolution), or null when the page has no images.
 */
async function imageResolution(page: PDFPageProxy): Promise<number | null> {
  const { OPS } = await pdfjs();
  const ol = await page.getOperatorList();
  let px = 0;
  ol.fnArray.forEach((fn, i) => {
    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const a = ol.argsArray[i] as unknown[];
      const w = typeof a[1] === "number" ? a[1] : (a[0] as { width?: number })?.width ?? 0;
      const h = typeof a[2] === "number" ? a[2] : (a[0] as { height?: number })?.height ?? 0;
      px = Math.max(px, w, h);
    }
  });
  if (!px) return null;
  const [x0, y0, x1, y1] = page.view as [number, number, number, number];
  return px / Math.max(x1 - x0, y1 - y0);
}

/**
 * Greyscale + 3×3 median filter: removes the isolated specks scanners and phone
 * cameras leave on paper, which Tesseract otherwise reads as ":" ";" "|" and
 * which drag down the confidence of real words on the same line.
 */
function despeckle(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { width: w, height: h } = canvas;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i]! * 77 + d[i + 1]! * 150 + d[i + 2]! * 29) >> 8;
  const out = new Uint8Array(g);
  const v = new Uint8Array(9);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = (y + dy) * w + x;
        v[k++] = g[row - 1]!; v[k++] = g[row]!; v[k++] = g[row + 1]!;
      }
      // Median of 9 by partial insertion sort (only the lower half is needed).
      for (let a = 1; a < 9; a++) {
        const t = v[a]!;
        let b = a - 1;
        while (b >= 0 && v[b]! > t) { v[b + 1] = v[b]!; b--; }
        v[b + 1] = t;
      }
      out[y * w + x] = v[4]!;
    }
  }
  for (let i = 0, j = 0; j < out.length; i += 4, j++) { d[i] = d[i + 1] = d[i + 2] = out[j]!; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
}

/** Render a page upright-as-displayed with an extra clockwise rotation. */
async function renderPage(page: PDFPageProxy, rotation: number, scale: number, clean: boolean) {
  const vp = page.getViewport({ scale, rotation: ((rotation % 360) + 360) % 360 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport: vp }).promise;
  if (clean) despeckle(canvas);
  return canvas;
}

/** Pixels per point for orientation probes (~120 dpi: enough to read, quick to run). */
const PROBE_SCALE = 120 / 72;

/**
 * Recognise text on PDF pages in the browser with Tesseract (self-hosted engine
 * and models). Each page is rendered as displayed at ~300 dpi; pages that read
 * poorly are tried turned 90°, 180° and 270°, and recognised in whichever way
 * reads best. Results come back as text-layer lines in each page's PDF space,
 * keyed by page ref, plus the turns that make sideways pages upright.
 */
export async function recognisePages(
  pages: OcrPageInput[],
  langs: OcrLang[],
  onProgress: (p: OcrProgress) => void,
  signal?: AbortSignal,
): Promise<OcrResult> {
  const total = pages.length;
  const out: OcrResult = { lines: {}, turns: {} };
  if (total === 0) return out;

  onProgress({ page: 0, total, fraction: 0, status: "loading" });
  const { createWorker } = await import("tesseract.js");
  let current = 0;
  let probing = false;
  const worker = await createWorker(langs, 1 /* LSTM only */, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract",
    langPath: "/tessdata",
    gzip: true,
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === "recognizing text" && !probing) {
        onProgress({ page: current, total, fraction: (current + 0.15 + 0.85 * m.progress) / total, status: "recognising" });
      }
    },
  });
  const abort = () => void worker.terminate();
  signal?.addEventListener("abort", abort);
  const check = () => { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); };

  try {
    for (let i = 0; i < total; i++) {
      check();
      current = i;
      onProgress({ page: i, total, fraction: i / total, status: "rendering" });
      const { ref, page, rotation, scanned: known } = pages[i]!;
      const shown = (page.rotate + rotation) % 360;

      // Scans are rendered at their own resolution (clamped to 200–400 dpi) so their
      // noise isn't resampled into blobs; other pages at 300 dpi. Capped for memory.
      const base = page.getViewport({ scale: 1, rotation: shown });
      const scanned = known ?? (await looksScanned(page).catch(() => false));
      const native = scanned ? await imageResolution(page).catch(() => null) : null;
      const target = native ? Math.min(400 / 72, Math.max(200 / 72, native)) : 300 / 72;
      const scale = Math.min(target, 4200 / Math.max(base.width, base.height));

      const read = async (turn: number) => {
        const canvas = await renderPage(page, shown + turn, scale, !!native);
        check();
        const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
        canvas.width = canvas.height = 0; // free the bitmap early
        return data.blocks as unknown as TBlock[];
      };

      let turn: 0 | 90 | 180 | 270 = 0;
      let blocks = await read(0);
      const conf = readingConfidence(blocks);
      if (conf.words >= 3 && conf.mean < UPRIGHT_CONFIDENCE) {
        // Reads poorly as shown: maybe the page is sideways or upside down. Try the
        // other orientations on a quick low-resolution render.
        onProgress({ page: i, total, fraction: (i + 0.6) / total, status: "orienting" });
        probing = true;
        const scores: Partial<Record<90 | 180 | 270, number>> = {};
        try {
          for (const t of [90, 270, 180] as const) {
            check();
            const small = await renderPage(page, shown + t, Math.min(PROBE_SCALE, scale), false);
            const { data } = await worker.recognize(small, {}, { blocks: true, text: false });
            small.width = small.height = 0;
            scores[t] = readingConfidence(data.blocks as unknown as TBlock[]).mean;
          }
        } finally {
          probing = false;
        }
        turn = pickTurn(conf.mean, scores);
        if (turn) {
          onProgress({ page: i, total, fraction: (i + 0.7) / total, status: "recognising" });
          blocks = await read(turn);
          out.turns[ref] = turn;
        }
      }

      out.lines[ref] = blocksToLines(blocks, {
        pxPerPt: scale,
        view: page.view as [number, number, number, number],
        rotate: (shown + turn) % 360,
      });
    }
    onProgress({ page: total - 1, total, fraction: 1, status: "done" });
    return out;
  } finally {
    signal?.removeEventListener("abort", abort);
    await worker.terminate().catch(() => {});
  }
}
