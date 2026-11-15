"use client";

import { inWorker, runExport } from "@/components/editor/exportClient";
import { looksScanned, recognisePages, type OcrLang } from "../ocr";
import { openPdf } from "../pdf";
import { pageImage, pageLayout, type PageLayout } from "./layout";

export type ConvertFormat = "docx" | "xlsx" | "pptx" | "jpg" | "png";

export const FORMAT_INFO: Record<ConvertFormat, { label: string; ext: string; mime: string }> = {
  docx: { label: "Word", ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { label: "Excel", ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { label: "PowerPoint", ext: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  jpg: { label: "JPG images", ext: "jpg", mime: "image/jpeg" },
  png: { label: "PNG images", ext: "png", mime: "image/png" },
};

export interface ConvertOptions {
  fileName: string;
  /** Page images: resolution. */
  dpi?: number;
  /** Recognise text on scanned pages first (Word, Excel, PowerPoint). */
  ocrLangs?: OcrLang[] | null;
}

export interface Converted { data: Uint8Array; name: string; mime: string; scannedPages: number; recognised: number }

type Progress = (fraction: number, note: string) => void;

/** How many pages are scans (no text), to offer OCR before converting. */
export async function countScannedPages(bytes: Uint8Array): Promise<number> {
  const doc = await openPdf(bytes);
  try {
    let n = 0;
    for (let i = 1; i <= doc.numPages; i++) if (await looksScanned(await doc.getPage(i))) n++;
    return n;
  } finally {
    await doc.loadingTask.destroy();
  }
}

/** Convert a PDF to Word, Excel, PowerPoint or page images, entirely in the browser. */
export async function convertPdf(bytes: Uint8Array, format: ConvertFormat, opts: ConvertOptions, onProgress: Progress): Promise<Converted> {
  const base = opts.fileName.replace(/\.pdf$/i, "");
  const info = FORMAT_INFO[format];
  let source = bytes;
  let scannedPages = 0, recognised = 0;

  // Scanned pages: recognise their text first so it can be edited in the result.
  if (format !== "jpg" && format !== "png") {
    const doc = await openPdf(source);
    try {
      const scans: Array<{ ref: string; page: Awaited<ReturnType<typeof doc.getPage>>; rotation: number; scanned: true }> = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        if (await looksScanned(page)) scans.push({ ref: `p${i}`, page, rotation: 0, scanned: true });
      }
      scannedPages = scans.length;
      if (scans.length && opts.ocrLangs?.length) {
        const result = await recognisePages(scans, opts.ocrLangs, (p) => onProgress(p.fraction * 0.5, p.status === "loading" ? "Loading the text recogniser…" : `Recognising text on page ${p.page + 1} of ${p.total}…`));
        recognised = scans.length;
        source = await runExport({
          base: source,
          ops: Object.entries(result.turns).map(([page, degrees]) => ({ op: "page.rotate" as const, page, degrees })),
          ocr: result.lines,
        });
      }
    } finally {
      await doc.loadingTask.destroy();
    }
  }
  const start = recognised ? 0.5 : 0;
  const step = (i: number, n: number, what: string) => onProgress(start + ((1 - start) * 0.9 * i) / Math.max(1, n), what);

  const doc = await openPdf(source);
  try {
    const n = doc.numPages;
    if (format === "jpg" || format === "png") {
      const files: Array<{ name: string; data: Uint8Array }> = [];
      for (let i = 1; i <= n; i++) {
        step(i - 1, n, `Rendering page ${i} of ${n}…`);
        const img = await pageImage(await doc.getPage(i), opts.dpi ?? 150, format);
        files.push({ name: n === 1 ? `${base}.${info.ext}` : `${base} - page ${String(i).padStart(String(n).length, "0")}.${info.ext}`, data: img.data });
      }
      onProgress(0.97, "Packing…");
      if (files.length === 1) return { data: files[0]!.data, name: files[0]!.name, mime: info.mime, scannedPages, recognised };
      const { zipSync } = await import("fflate");
      const zip = zipSync(Object.fromEntries(files.map((f) => [f.name, [f.data, { level: 0 }]])));
      return { data: zip, name: `${base} (pages).zip`, mime: "application/zip", scannedPages, recognised };
    }

    const layouts: PageLayout[] = [];
    for (let i = 1; i <= n; i++) {
      step(i - 1, n, `Reading page ${i} of ${n}…`);
      layouts.push(await pageLayout(await doc.getPage(i), { pictures: format === "docx" }));
    }
    onProgress(start + (1 - start) * 0.92, `Writing the ${info.label} file…`);

    let data: Uint8Array;
    if (format === "docx") {
      data = await (await import("./docx")).layoutsToDocx(layouts, base);
    } else if (format === "xlsx") {
      data = await (await import("./xlsx")).layoutsToXlsx(layouts);
    } else {
      // Slides: the page without its text as the background, text as editable boxes.
      const reply = await inWorker({ type: "stripText", bytes: source });
      const stripped = reply && reply.ok && "compressed" in reply ? reply.compressed : await (await import("@pdfinkly/shared/export")).stripText(source);
      const bg = await openPdf(stripped);
      try {
        const pages = [];
        for (let i = 1; i <= n; i++) pages.push({ layout: layouts[i - 1]!, background: { ...(await pageImage(await bg.getPage(i), 150, "jpg")), type: "jpg" as const } });
        data = await (await import("./pptx")).layoutsToPptx(pages, base);
      } finally {
        await bg.loadingTask.destroy();
      }
    }
    onProgress(1, "Done");
    return { data, name: `${base}.${info.ext}`, mime: info.mime, scannedPages, recognised };
  } finally {
    await doc.loadingTask.destroy();
  }
}
