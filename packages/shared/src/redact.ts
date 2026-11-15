import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFRawStream,
  PDFRef,
  PDFStream,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFPage,
} from "pdf-lib";
import { IDENTITY, multiply, overlaps, redactStream, transformPoint, unitBox, type Box, type Matrix } from "./contentstream";
import { deriveModel, type DocModel, type Operation, type Rect } from "./operations";
import { fontResolverForResources, pageContent, setPageContent, streamBytes } from "./pdftext";

/**
 * True redaction: everything under a marked area is deleted from the file, not
 * hidden. Text glyphs (including invisible OCR text), vector drawings that lie
 * inside the area, inline images, the content of form XObjects, overlapping PDF
 * annotations and form fields go; image pixels under the area are replaced with
 * black (the image is decoded and re-encoded in the browser, see
 * planRedactionImages). A black box is then drawn over each area.
 */

/** Set on image streams whose pixels have been blacked out, so they're kept. */
const CLEANED = PDFName.of("PDFInklyRedacted");

export interface RedactStats {
  glyphs: number;
  paths: number;
  inlineImages: number;
  imagesCleaned: number;
  /** Images under a redaction that couldn't be cleaned, so they were removed. */
  imagesRemoved: number;
  forms: number;
  annots: number;
}

const emptyStats = (): RedactStats => ({ glyphs: 0, paths: 0, inlineImages: 0, imagesCleaned: 0, imagesRemoved: 0, forms: 0, annots: 0 });

/** Redaction rects per page ref. */
export function redactionsByPage(model: DocModel): Map<string, Rect[]> {
  const out = new Map<string, Rect[]>();
  for (const a of model.annotations) {
    if (a.annot.kind !== "redact") continue;
    out.set(a.page, [...(out.get(a.page) ?? []), a.annot.rect]);
  }
  return out;
}

function xobject(res: PDFDict | undefined, name: string): { ref?: PDFRef; obj?: PDFStream } {
  const dict = res?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!dict) return {};
  const raw = dict.get(PDFName.of(name));
  const obj = dict.lookupMaybe(PDFName.of(name), PDFStream);
  return { ref: raw instanceof PDFRef ? raw : undefined, obj };
}

const nums = (arr: PDFArray | undefined, n: number, fallback: number[]) => {
  if (!arr || arr.size() < n) return fallback;
  return Array.from({ length: n }, (_, i) => (arr.lookup(i) as PDFNumber | undefined)?.asNumber?.() ?? fallback[i]!);
};

const subtype = (s: PDFStream) => s.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();

interface ImageHit { ref: PDFRef; obj: PDFStream; ctm: Matrix }

/**
 * Walk a content stream and the forms it draws. With `write`, rewrite them
 * (deleting what's under the rects); always collect images under the rects.
 */
function walk(doc: PDFDocument, content: Uint8Array, res: PDFDict | undefined, rects: Box[], ctm: Matrix, depth: number, write: boolean, stats: RedactStats, hits: ImageHit[]): Uint8Array | null {
  const result = redactStream(content, fontResolverForResources(res), rects, {
    ctm,
    dropXObject: (call) => {
      const { ref, obj } = xobject(res, call.name);
      if (!obj) return false;
      const kind = subtype(obj);
      if (kind === "Image") {
        if (!rects.some((r) => overlaps(unitBox(call.ctm), r))) return false;
        if (ref) hits.push({ ref, obj, ctm: call.ctm });
        if (!write) return false;
        if (obj.dict.get(CLEANED)) { stats.imagesCleaned++; return false; }
        stats.imagesRemoved++;
        return true;
      }
      if (kind === "Form" && depth < 8) {
        const m = multiply(nums(obj.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray), 6, [1, 0, 0, 1, 0, 0]) as Matrix, call.ctm);
        const [bx0, by0, bx1, by1] = nums(obj.dict.lookupMaybe(PDFName.of("BBox"), PDFArray), 4, [0, 0, 0, 0]);
        const corners = [transformPoint(m, bx0!, by0!), transformPoint(m, bx1!, by0!), transformPoint(m, bx0!, by1!), transformPoint(m, bx1!, by1!)];
        const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
        const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        if (bx1! > bx0! && !rects.some((r) => overlaps(box, r))) return false;
        const inner = streamBytes(obj);
        if (!inner) return false;
        const fres = obj.dict.lookupMaybe(PDFName.of("Resources"), PDFDict) ?? res;
        const rewritten = walk(doc, inner, fres, rects, m, depth + 1, write, stats, hits);
        if (write && rewritten && ref) {
          const s = doc.context.flateStream(rewritten);
          for (const [k, v] of obj.dict.entries()) {
            const key = k.decodeText();
            if (key !== "Length" && key !== "Filter" && key !== "DecodeParms") s.dict.set(k, v);
          }
          doc.context.assign(ref, s);
          stats.forms++;
        }
        return false;
      }
      return false;
    },
  });
  if (write) {
    stats.glyphs += result.glyphs;
    stats.paths += result.paths;
    stats.inlineImages += result.inlineImages;
  }
  return result.bytes;
}

/** Redact one page in place and draw the black boxes. */
export function redactPage(doc: PDFDocument, page: PDFPage, rects: Rect[]): RedactStats {
  const stats = emptyStats();
  const boxes: Box[] = rects.map((r) => ({ ...r }));
  const out = walk(doc, pageContent(page), page.node.Resources(), boxes, [...IDENTITY] as Matrix, 0, true, stats, []);
  if (out) setPageContent(doc, page, out);

  // PDF annotations (links, comments, stamps, leftover widgets) over a redaction go too.
  const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (annots) {
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i);
      // Entries left dangling by form flattening go too.
      if (!(a instanceof PDFDict)) { annots.remove(i); continue; }
      const [x0, y0, x1, y1] = nums(a.lookupMaybe(PDFName.of("Rect"), PDFArray), 4, [0, 0, 0, 0]);
      const box = { x: Math.min(x0!, x1!), y: Math.min(y0!, y1!), w: Math.abs(x1! - x0!), h: Math.abs(y1! - y0!) };
      if (boxes.some((r) => overlaps(box, r))) { annots.remove(i); stats.annots++; }
    }
  }
  for (const r of rects) page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(0, 0, 0) });
  return stats;
}

/* --------------------------------------------------------- image pixels */

/** One image to black out in the browser: a one-image PDF to render, and pixel boxes. */
export interface RedactImageJob {
  /** `<doc key>:<object number>:<generation>`; doc key = "base" or a merged version id. */
  key: string;
  width: number;
  height: number;
  /** Re-encode as greyscale (the original has no colour). */
  gray: boolean;
  /** Re-encode as JPEG (the original was JPEG/JPEG 2000) rather than lossless. */
  jpeg: boolean;
  /** Pixel boxes [x0, y0, x1, y1], origin top-left, to fill with black. */
  boxes: Array<[number, number, number, number]>;
  /** A PDF whose single page (width × height points) shows just this image. */
  pdf: Uint8Array;
}

/** The blacked-out image, encoded by the browser. */
export interface RedactImageResult {
  key: string;
  width: number;
  height: number;
  gray: boolean;
  /** DCTDecode (JPEG) bytes, or FlateDecode (zlib) 8-bit samples. */
  filter: "DCTDecode" | "FlateDecode";
  data: Uint8Array;
}

/** Images bigger than this aren't decoded in the browser; they're removed instead. */
const MAX_PIXELS = 60_000_000;

const invert = (m: Matrix): Matrix | null => {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};

function isGray(obj: PDFStream): boolean {
  const bpc = obj.dict.lookupMaybe(PDFName.of("BitsPerComponent"), PDFNumber)?.asNumber() ?? 8;
  const cs = obj.dict.lookup(PDFName.of("ColorSpace"));
  if (cs instanceof PDFName) return cs.decodeText() === "DeviceGray" || cs.decodeText() === "CalGray";
  if (cs instanceof PDFArray) {
    const fam = (cs.lookup(0) as PDFName | undefined)?.decodeText?.();
    if (fam === "CalGray") return true;
    if (fam === "ICCBased") {
      const prof = cs.lookup(1);
      return prof instanceof PDFStream && prof.dict.lookupMaybe(PDFName.of("N"), PDFNumber)?.asNumber() === 1;
    }
    return false;
  }
  return bpc === 1 && !cs; // JBIG2 often has DeviceGray; bare 1-bit images are bilevel
}

function filters(obj: PDFStream): string[] {
  const f = obj.dict.lookup(PDFName.of("Filter"));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return Array.from({ length: f.size() }, (_, i) => (f.lookup(i) as PDFName).decodeText());
  return [];
}

/**
 * Find the images that lie under redactions and describe how to black them out.
 * Runs in the export worker; the browser renders each job's PDF, fills the
 * boxes and encodes the result (exportPdf then swaps it in).
 */
export async function planRedactionImages({ base, ops, external = {} }: { base: Uint8Array; ops: readonly Operation[]; external?: Record<string, Uint8Array> }): Promise<RedactImageJob[]> {
  const src = await PDFDocument.load(base, { updateMetadata: false });
  const model = deriveModel(src.getPageCount(), ops);
  const byPage = redactionsByPage(model);
  if (byPage.size === 0) return [];

  // Group redacted pages by source document.
  const perDoc = new Map<string, Array<{ index: number; rects: Rect[] }>>();
  for (const entry of model.pages) {
    const rects = byPage.get(entry.ref);
    if (!rects || entry.source.kind === "blank") continue;
    const key = entry.source.kind === "base" ? "base" : entry.source.versionId;
    perDoc.set(key, [...(perDoc.get(key) ?? []), { index: entry.source.index, rects }]);
  }

  const jobs = new Map<string, RedactImageJob & { obj: PDFStream; doc: PDFDocument }>();
  for (const [docKey, pages] of perDoc) {
    const doc = docKey === "base" ? src : external[docKey] ? await PDFDocument.load(external[docKey]!, { updateMetadata: false }) : null;
    if (!doc) continue;
    for (const { index, rects } of pages) {
      const page = doc.getPage(index);
      const hits: ImageHit[] = [];
      walk(doc, pageContent(page), page.node.Resources(), rects, [...IDENTITY] as Matrix, 0, false, emptyStats(), hits);
      for (const hit of hits) {
        if (hit.obj.dict.get(PDFName.of("ImageMask"))?.toString() === "true") continue; // stencils are removed
        const width = hit.obj.dict.lookupMaybe(PDFName.of("Width"), PDFNumber)?.asNumber() ?? 0;
        const height = hit.obj.dict.lookupMaybe(PDFName.of("Height"), PDFNumber)?.asNumber() ?? 0;
        if (!width || !height || width * height > MAX_PIXELS) continue;
        const inv = invert(hit.ctm);
        if (!inv) continue;
        const key = `${docKey}:${hit.ref.objectNumber}:${hit.ref.generationNumber}`;
        let job = jobs.get(key);
        if (!job) {
          const fl = filters(hit.obj);
          job = { key, width, height, gray: isGray(hit.obj), jpeg: fl.includes("DCTDecode") || fl.includes("JPXDecode"), boxes: [], pdf: new Uint8Array(), obj: hit.obj, doc };
          jobs.set(key, job);
        }
        for (const r of rects) {
          if (!overlaps(unitBox(hit.ctm), r)) continue;
          // Rect corners in the image's unit space → pixel box (top-left origin), with a 1 px margin.
          const uv = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].map(([x, y]) => transformPoint(inv, x!, y!));
          const us = uv.map((p) => p[0]), vs = uv.map((p) => p[1]);
          const x0 = Math.max(0, Math.floor(Math.min(...us) * width) - 1);
          const x1 = Math.min(width, Math.ceil(Math.max(...us) * width) + 1);
          const y0 = Math.max(0, Math.floor((1 - Math.max(...vs)) * height) - 1);
          const y1 = Math.min(height, Math.ceil((1 - Math.min(...vs)) * height) + 1);
          if (x1 > x0 && y1 > y0) job.boxes.push([x0, y0, x1, y1]);
        }
      }
    }
  }

  const out: RedactImageJob[] = [];
  for (const job of jobs.values()) {
    if (!job.boxes.length) continue;
    const mini = await PDFDocument.create();
    const copy = PDFObjectCopier.for(job.doc.context, mini.context).copy(job.obj);
    // Render the samples alone, opaque: the soft mask stays on the original object.
    copy.dict.delete(PDFName.of("SMask"));
    copy.dict.delete(PDFName.of("Mask"));
    const ref = mini.context.register(copy);
    const page = mini.addPage([job.width, job.height]);
    page.node.setXObject(PDFName.of("Im0"), ref);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(job.width, 0, 0, job.height, 0, 0), drawObject("Im0"), popGraphicsState());
    const { obj: _o, doc: _d, ...rest } = job;
    out.push({ ...rest, pdf: await mini.save() });
  }
  return out;
}

/** Swap blacked-out images into a source document (before its pages are copied). */
export function applyRedactedImages(doc: PDFDocument, docKey: string, results: readonly RedactImageResult[]) {
  for (const r of results) {
    const [k, num, gen] = r.key.split(":");
    if (k !== docKey) continue;
    const ref = PDFRef.of(Number(num), Number(gen));
    const old = doc.context.lookup(ref);
    if (!(old instanceof PDFStream)) continue;
    const dict = doc.context.obj({
      Type: "XObject",
      Subtype: "Image",
      Width: r.width,
      Height: r.height,
      ColorSpace: r.gray ? "DeviceGray" : "DeviceRGB",
      BitsPerComponent: 8,
      Filter: r.filter,
    });
    const smask = old.dict.get(PDFName.of("SMask"));
    if (smask) dict.set(PDFName.of("SMask"), smask);
    const interp = old.dict.get(PDFName.of("Interpolate"));
    if (interp) dict.set(PDFName.of("Interpolate"), interp);
    dict.set(CLEANED, PDFBool.True);
    doc.context.assign(ref, PDFRawStream.of(dict, r.data));
  }
}
