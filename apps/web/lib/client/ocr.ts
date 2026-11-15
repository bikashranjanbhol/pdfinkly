"use client";

import type { PDFPageProxy } from "pdfjs-dist";
import type { OcrLine } from "@pdfinkly/shared";
import { blocksToLines } from "./ocrMap";
import { pdfjs } from "./pdf";

export type OcrLang = "eng" | "hin";

export const OCR_LANGS: Record<OcrLang, string> = { eng: "English", hin: "Hindi (हिन्दी)" };

export interface OcrProgress {
  /** 0-based index of the page being processed, among the selected pages. */
  page: number;
  total: number;
  /** Overall progress 0..1. */
  fraction: number;
  status: "loading" | "rendering" | "recognising" | "done";
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

/**
 * Recognise text on PDF pages in the browser with Tesseract (self-hosted engine
 * and models). Each page is rendered upright at ~300 dpi; results come back as
 * text-layer lines in the page's PDF space, keyed by page ref.
 */
export async function recognisePages(
  pages: Array<{ ref: string; page: PDFPageProxy }>,
  langs: OcrLang[],
  onProgress: (p: OcrProgress) => void,
  signal?: AbortSignal,
): Promise<Record<string, OcrLine[]>> {
  const total = pages.length;
  const out: Record<string, OcrLine[]> = {};
  if (total === 0) return out;

  onProgress({ page: 0, total, fraction: 0, status: "loading" });
  const { createWorker } = await import("tesseract.js");
  let current = 0;
  let pageFraction = 0;
  const worker = await createWorker(langs, 1 /* LSTM only */, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract",
    langPath: "/tessdata",
    gzip: true,
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === "recognizing text") {
        pageFraction = m.progress;
        onProgress({ page: current, total, fraction: (current + 0.15 + 0.85 * pageFraction) / total, status: "recognising" });
      }
    },
  });
  const abort = () => void worker.terminate();
  signal?.addEventListener("abort", abort);

  try {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      current = i;
      pageFraction = 0;
      onProgress({ page: i, total, fraction: i / total, status: "rendering" });
      const { ref, page } = pages[i]!;

      // Render upright (with the page's own rotation). Scans are rendered at their own
      // resolution (clamped to 200–400 dpi) so their noise isn't resampled into blobs;
      // other pages at 300 dpi. Capped for memory.
      const base = page.getViewport({ scale: 1, rotation: page.rotate });
      const scanned = await looksScanned(page).catch(() => false);
      const native = scanned ? await imageResolution(page).catch(() => null) : null;
      const target = native ? Math.min(400 / 72, Math.max(200 / 72, native)) : 300 / 72;
      const scale = Math.min(target, 4200 / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale, rotation: page.rotate });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport: vp }).promise;
      if (native) despeckle(canvas);

      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
      out[ref] = blocksToLines(data.blocks as never, {
        pxPerPt: scale,
        view: page.view as [number, number, number, number],
        rotate: page.rotate,
      });
      canvas.width = canvas.height = 0; // free the bitmap early
    }
    onProgress({ page: total - 1, total, fraction: 1, status: "done" });
    return out;
  } finally {
    signal?.removeEventListener("abort", abort);
    await worker.terminate().catch(() => {});
  }
}
