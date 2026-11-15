"use client";

import type { CompressJob, CompressResult } from "@pdfinkly/shared/export";
import { inWorker } from "@/components/editor/exportClient";
import { openPdf } from "./pdf";

export type CompressMode = { preset: "light" | "recommended" | "strong" } | { targetBytes: number };

/** Resolution (dpi at the size an image is shown) and JPEG quality, gentlest first. */
const LADDER: Array<[number, number]> = [[220, 0.82], [150, 0.72], [120, 0.62], [100, 0.52], [85, 0.46], [72, 0.4], [60, 0.34], [50, 0.28]];
const PRESET = { light: 0, recommended: 1, strong: 3 } as const;

export interface CompressOutcome {
  bytes: Uint8Array;
  /** Whether a size target was met (always true for presets). */
  reached: boolean;
  /** Images re-encoded, of those worth trying. */
  images: number;
}

async function plan(bytes: Uint8Array): Promise<CompressJob[]> {
  const r = await inWorker({ type: "compressPlan", bytes });
  if (r && r.ok && "compressJobs" in r) return r.compressJobs;
  if (r && !r.ok) throw new Error(r.message);
  return (await import("@pdfinkly/shared/export")).planCompression(bytes);
}

async function apply(bytes: Uint8Array, results: CompressResult[]): Promise<Uint8Array> {
  const r = await inWorker({ type: "compressApply", bytes, results });
  if (r && r.ok && "compressed" in r) return r.compressed;
  if (r && !r.ok) throw new Error(r.message);
  return (await import("@pdfinkly/shared/export")).applyCompression(bytes, results);
}

/** qpdf's structural squeeze: object streams, recompressed streams, unused resources removed. */
async function squeeze(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const { optimizePdf } = await import("./qpdf");
    const out = await optimizePdf(bytes);
    return out.length < bytes.length ? out : bytes;
  } catch {
    return bytes;
  }
}

const toBlob = (c: HTMLCanvasElement, q: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't encode an image"))), "image/jpeg", q));

/** Decoded images, kept at the largest size any attempt needs (≤ 220 dpi as shown). */
class Images {
  private cache = new Map<string, HTMLCanvasElement>();
  constructor(private jobs: CompressJob[], private keep: boolean) {}

  private async render(job: CompressJob, scale: number): Promise<HTMLCanvasElement> {
    const doc = await openPdf(job.pdf);
    try {
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(vp.width));
      c.height = Math.max(1, Math.round(vp.height));
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvas: c, viewport: vp }).promise;
      return c;
    } finally {
      await doc.loadingTask.destroy();
    }
  }

  /** Re-encode every image at `dpi` and `quality`; only results smaller than the original. */
  async encode([dpi, quality]: [number, number], onImage: () => void): Promise<CompressResult[]> {
    const out: CompressResult[] = [];
    for (const job of this.jobs) {
      const want = Math.min(1, ((job.shownWidth / 72) * dpi) / job.width, ((job.shownHeight / 72) * dpi) / job.height);
      const top = Math.min(1, ((job.shownWidth / 72) * LADDER[0]![0]) / job.width);
      let src = this.cache.get(job.key);
      if (!src) {
        src = await this.render(job, this.keep ? top : want);
        if (this.keep) this.cache.set(job.key, src);
      }
      const w = Math.max(1, Math.round(job.width * want)), h = Math.max(1, Math.round(job.height * want));
      let c = src;
      if (src.width !== w || src.height !== h) {
        c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(src, 0, 0, w, h);
      }
      const data = new Uint8Array(await (await toBlob(c, quality)).arrayBuffer());
      if (c !== src) c.width = c.height = 0;
      if (!this.keep) src.width = src.height = 0;
      if (data.length < job.bytes * 0.95) out.push({ key: job.key, width: w, height: h, data });
      onImage();
    }
    return out;
  }

  dispose() {
    for (const c of this.cache.values()) c.width = c.height = 0;
    this.cache.clear();
  }
}

/**
 * Make a PDF smaller in the browser: re-encode its images at a lower
 * resolution/quality and squeeze its structure. With a target size, steps
 * down the quality ladder until the file fits (or there's nothing left).
 */
export async function compressPdf(bytes: Uint8Array, mode: CompressMode, onProgress: (fraction: number, note: string) => void): Promise<CompressOutcome> {
  onProgress(0.02, "Looking at the images…");
  const jobs = await plan(bytes);
  const pixels = jobs.reduce((n, j) => n + j.width * j.height, 0);
  const images = new Images(jobs, "targetBytes" in mode && pixels < 80_000_000);
  try {
    const attempt = async (level: number, from: number, to: number) => {
      let done = 0;
      const results = jobs.length ? await images.encode(LADDER[level]!, () => onProgress(from + ((to - from) * 0.8 * ++done) / jobs.length, `Compressing images (${done} of ${jobs.length})…`)) : [];
      onProgress(from + (to - from) * 0.85, "Optimising the file…");
      const out = await squeeze(await apply(bytes, results));
      return { out: out.length < bytes.length ? out : bytes, count: results.length };
    };

    if ("preset" in mode) {
      const r = await attempt(PRESET[mode.preset], 0.05, 1);
      onProgress(1, "Done");
      return { bytes: r.out, reached: true, images: r.count };
    }

    // Target size: start at "recommended", go gentler if it fits easily, else step down.
    const target = mode.targetBytes;
    let level = 1;
    let best = await attempt(level, 0.05, 0.35);
    if (best.out.length <= target) {
      const gentler = await attempt(0, 0.35, 0.6);
      if (gentler.out.length <= target) best = gentler;
      onProgress(1, "Done");
      return { bytes: best.out, reached: true, images: best.count };
    }
    if (!jobs.length) {
      onProgress(1, "Done");
      return { bytes: best.out, reached: false, images: 0 };
    }
    // Step down (jumping further when far off: JPEG size roughly follows pixel count), then
    // step back up through skipped levels so the result keeps the most quality that fits.
    let lastMiss = level;
    let fit: { level: number; out: Uint8Array; count: number } | null = null;
    let smallest = best;
    const span = (l: number) => [0.35 + (0.55 * l) / LADDER.length, 0.35 + (0.55 * (l + 1)) / LADDER.length] as const;
    while (!fit && level < LADDER.length - 1) {
      const ratio = smallest.out.length / target;
      level = Math.min(LADDER.length - 1, level + (ratio > 3 ? 3 : ratio > 1.6 ? 2 : 1));
      const r = await attempt(level, ...span(level));
      if (r.out.length < smallest.out.length) smallest = r;
      if (r.out.length <= target) fit = { level, ...r };
      else lastMiss = level;
    }
    while (fit && fit.level - 1 > lastMiss) {
      const up = fit.level - 1;
      const r = await attempt(up, ...span(up));
      if (r.out.length <= target) fit = { level: up, ...r };
      else lastMiss = up;
    }
    onProgress(1, "Done");
    const chosen = fit ?? smallest;
    return { bytes: chosen.out, reached: chosen.out.length <= target, images: chosen.count };
  } finally {
    images.dispose();
  }
}
