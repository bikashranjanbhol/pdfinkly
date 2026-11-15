"use client";

import { findInRuns, type PiiKind, type PiiMatch, type Rect, type TextRun } from "@pdfinkly/shared";
import type { RedactImageJob, RedactImageResult } from "@pdfinkly/shared/export";
import type { PDFPageProxy } from "pdfjs-dist";
import { openPdf } from "./pdf";

/** Zlib-compress bytes with the browser's own CompressionStream (FlateDecode in PDF). */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode the image"))), type, quality));

/**
 * Black out image pixels under redactions: render each image on its own with
 * PDF.js (which decodes every image format PDFs use: JPEG, JPEG 2000, JBIG2,
 * CCITT, Flate…), fill the boxes, and re-encode it (JPEG for photos and scans
 * that were JPEG, lossless otherwise).
 */
export async function cleanRedactedImages(jobs: RedactImageJob[]): Promise<RedactImageResult[]> {
  const out: RedactImageResult[] = [];
  for (const job of jobs) {
    const doc = await openPdf(job.pdf);
    try {
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = job.width;
      canvas.height = job.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: !job.jpeg })!;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport: vp }).promise;
      ctx.fillStyle = "#000000";
      for (const [x0, y0, x1, y1] of job.boxes) ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

      if (job.jpeg) {
        const data = new Uint8Array(await (await toBlob(canvas, "image/jpeg", 0.92)).arrayBuffer());
        out.push({ key: job.key, width: job.width, height: job.height, gray: false, filter: "DCTDecode", data });
      } else {
        const rgba = ctx.getImageData(0, 0, job.width, job.height).data;
        const n = job.width * job.height;
        const samples = new Uint8Array(job.gray ? n : n * 3);
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          if (job.gray) samples[i] = (rgba[j]! * 77 + rgba[j + 1]! * 150 + rgba[j + 2]! * 29) >> 8;
          else { samples[i * 3] = rgba[j]!; samples[i * 3 + 1] = rgba[j + 1]!; samples[i * 3 + 2] = rgba[j + 2]!; }
        }
        out.push({ key: job.key, width: job.width, height: job.height, gray: job.gray, filter: "FlateDecode", data: await deflate(samples) });
      }
      canvas.width = canvas.height = 0;
    } catch {
      // Left out: the export then removes this image entirely and says so.
    } finally {
      await doc.loadingTask.destroy();
    }
  }
  return out;
}

const runsOf = async (page: PDFPageProxy): Promise<TextRun[]> =>
  ((await page.getTextContent()).items as Array<{ str?: string; transform?: number[]; width?: number }>)
    .filter((i) => i.str && i.transform)
    .map((i) => ({ str: i.str!, transform: i.transform!, width: i.width ?? 0 }));

/** Find personal data (or a search term) on one page. */
export async function findOnPage(page: PDFPageProxy, kinds: PiiKind[], custom?: string): Promise<PiiMatch[]> {
  return findInRuns(await runsOf(page), kinds, custom);
}

const inside = (x: number, y: number, r: Rect, inset = 1) => x > r.x + inset && x < r.x + r.w - inset && y > r.y + inset && y < r.y + r.h - inset;

/**
 * Check a saved PDF: no text may remain under a redaction, and none of the
 * marked texts may still be on its page. Returns what leaked (empty = clean).
 */
export async function verifyRedactions(bytes: Uint8Array, pages: Array<{ index: number; rects: Rect[]; texts: string[] }>): Promise<string[]> {
  if (!pages.length) return [];
  const doc = await openPdf(bytes);
  const leaks: string[] = [];
  try {
    for (const p of pages) {
      const runs = await runsOf(await doc.getPage(p.index + 1));
      for (const r of runs) {
        const t = r.transform;
        const size = Math.hypot(t[2]!, t[3]!) || 1;
        const n = Math.hypot(t[0]!, t[1]!) || 1;
        // Middle of the run, a third of the way up its letters.
        const cx = t[4]! + (t[0]! / n) * (r.width / 2) + (t[2]! / size) * size * 0.35;
        const cy = t[5]! + (t[1]! / n) * (r.width / 2) + (t[3]! / size) * size * 0.35;
        if (r.str.trim() && p.rects.some((rect) => inside(cx, cy, rect))) leaks.push(r.str.trim());
      }
      for (const text of p.texts) {
        if (text.replace(/\s/g, "").length < 4) continue;
        // Still findable where it was marked (other copies elsewhere on the page may be intentional).
        const still = findInRuns(runs, ["custom"], text).some((m) => p.rects.some((rect) => inside(m.rect.x + m.rect.w / 2, m.rect.y + m.rect.h / 2, rect, 0)));
        if (still) leaks.push(text);
      }
    }
  } finally {
    await doc.loadingTask.destroy();
  }
  return [...new Set(leaks)];
}
