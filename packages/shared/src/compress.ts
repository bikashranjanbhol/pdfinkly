import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import { unitBox } from "./contentstream";
import { filters, imageOnlyPdf, imagesOnPage } from "./redact";

/**
 * Compression, done in three places:
 *  1. here (worker): list the images worth shrinking, with how big each is
 *     actually shown, as one-image PDFs for the browser to decode;
 *  2. the browser: render each, downscale to a target resolution and encode
 *     as JPEG (keeping only results that are smaller);
 *  3. here again: swap the smaller images in, drop metadata and thumbnails,
 *     and save with object streams (qpdf then recompresses what's left).
 */

export interface CompressJob {
  key: string;
  width: number;
  height: number;
  /** Largest size the image is drawn at on any page, in points. */
  shownWidth: number;
  shownHeight: number;
  /** Current encoded size, bytes: a replacement must beat it. */
  bytes: number;
  /** Has a soft mask (transparency), kept as it is. */
  alpha: boolean;
  pdf: Uint8Array;
}

export interface CompressResult {
  key: string;
  width: number;
  height: number;
  /** JPEG bytes. */
  data: Uint8Array;
}

/** Below this an image isn't worth re-encoding. */
const MIN_BYTES = 12 * 1024;

export async function planCompression(bytes: Uint8Array): Promise<CompressJob[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const found = new Map<string, { ref: PDFRef; obj: PDFStream; w: number; h: number }>();
  for (const page of doc.getPages()) {
    for (const hit of imagesOnPage(doc, page)) {
      const key = `${hit.ref.objectNumber}:${hit.ref.generationNumber}`;
      const box = unitBox(hit.ctm);
      const cur = found.get(key);
      found.set(key, { ref: hit.ref, obj: hit.obj, w: Math.max(cur?.w ?? 0, box.w), h: Math.max(cur?.h ?? 0, box.h) });
    }
  }
  const jobs: CompressJob[] = [];
  for (const [key, { obj, w, h }] of found) {
    const d = obj.dict;
    if (d.get(PDFName.of("ImageMask"))?.toString() === "true") continue;
    const bpc = d.lookupMaybe(PDFName.of("BitsPerComponent"), PDFNumber)?.asNumber() ?? 8;
    const fl = filters(obj);
    if (bpc === 1 || fl.includes("JBIG2Decode") || fl.includes("CCITTFaxDecode")) continue; // bilevel scans: already tiny
    const size = obj instanceof PDFRawStream ? obj.getContents().length : 0;
    if (size < MIN_BYTES) continue;
    const width = d.lookupMaybe(PDFName.of("Width"), PDFNumber)?.asNumber() ?? 0;
    const height = d.lookupMaybe(PDFName.of("Height"), PDFNumber)?.asNumber() ?? 0;
    if (!width || !height || width * height > 60_000_000) continue;
    jobs.push({
      key, width, height, shownWidth: w, shownHeight: h, bytes: size,
      alpha: !!d.get(PDFName.of("SMask")),
      pdf: await imageOnlyPdf(doc, obj, width, height),
    });
  }
  return jobs;
}

/** Swap in the smaller images, drop metadata/thumbnails, save compactly. */
export async function applyCompression(bytes: Uint8Array, results: readonly CompressResult[], opts: { stripMetadata?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const r of results) {
    const [num, gen] = r.key.split(":").map(Number);
    const ref = PDFRef.of(num!, gen!);
    const old = doc.context.lookup(ref);
    if (!(old instanceof PDFStream)) continue;
    const dict = doc.context.obj({ Type: "XObject", Subtype: "Image", Width: r.width, Height: r.height, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" });
    for (const k of ["SMask", "Interpolate", "Intent"]) {
      const v = old.dict.get(PDFName.of(k));
      if (v) dict.set(PDFName.of(k), v);
    }
    doc.context.assign(ref, PDFRawStream.of(dict, r.data));
  }
  if (opts.stripMetadata !== false) {
    doc.catalog.delete(PDFName.of("Metadata"));
    for (const page of doc.getPages()) {
      page.node.delete(PDFName.of("Thumb"));
      page.node.delete(PDFName.of("PieceInfo"));
    }
    doc.catalog.delete(PDFName.of("PieceInfo"));
  }
  return doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
}
