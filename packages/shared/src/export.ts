import {
  BlendMode,
  LineCapStyle,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { faceFile, layoutReplaceLines } from "./fonts";
import { visualSize, visualToPage } from "./visual";
export { visualSize, visualToPage } from "./visual";
export { layoutReplaceLines } from "./fonts";
import { deriveModel, type Annotation, type DocModel, type Face, type FontName, type Operation, type PageEntry, type Rect } from "./operations";
import { drawOcrLayer, OCR_FONT_NAME, type OcrLine } from "./ocr";
import { removeOcrLayer, removeTextFromPageDetailed } from "./pdftext";
import { applyRedactedImages, redactionsByPage, redactPage, type RedactImageResult, type RedactStats } from "./redact";
import { overlaps } from "./contentstream";
import { drawStamps } from "./stamps";
export { planRedactionImages, type RedactImageJob, type RedactImageResult } from "./redact";

export interface ExportInput {
  /** Bytes of the base version the operations were made against. */
  base: Uint8Array;
  ops: readonly Operation[];
  /** Bytes of other versions merged in with page.insertFrom, keyed by version id. */
  external?: Record<string, Uint8Array>;
  /** Fetch a bundled font file (e.g. "carlito-latin-400-normal.woff") for edited text. */
  loadFont?: (file: string) => Promise<Uint8Array>;
  /** Called when edited text couldn't be removed from the file and was covered instead. */
  onWarning?: (message: string) => void;
  /** Recognised text to add as an invisible, searchable layer, keyed by page ref. */
  ocr?: Record<string, OcrLine[]>;
  /** Images under redactions with their pixels blacked out (see planRedactionImages). */
  redactImages?: RedactImageResult[];
}

export class ExportError extends Error {
  constructor(public code: "ENCRYPTED" | "MISSING_EXTERNAL" | "INVALID_PDF", message: string) {
    super(message);
  }
}

const hex = (c: string) => {
  const n = Number.parseInt(c.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/encrypt/i.test(msg)) throw new ExportError("ENCRYPTED", "This PDF is password protected.");
    throw new ExportError("INVALID_PDF", msg);
  }
}

const FONT_MAP: Record<FontName, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  TimesRoman: StandardFonts.TimesRoman,
  Courier: StandardFonts.Courier,
};

function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const next = line + w;
      if (line && font.widthOfTextAtSize(next.trimEnd(), size) > maxWidth) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else {
        line = next;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Standard fonts only cover WinAnsi; replace anything else so drawing never throws. */
function sanitize(text: string, font: PDFFont): string {
  const chars = font.getCharacterSet();
  const set = new Set(chars);
  return Array.from(text, (ch) => (ch === "\n" || set.has(ch.codePointAt(0)!) ? ch : "?")).join("");
}

function drawTextBlock(page: PDFPage, rect: Rect, rot: number, text: string, font: PDFFont, size: number, color: string, pad = 2) {
  const vis = visualSize(rect, rot);
  const lineHeight = size * 1.2;
  const lines = wrapLines(sanitize(text, font), font, size, Math.max(vis.w - pad * 2, size));
  lines.forEach((line, i) => {
    if (!line) return;
    const [x, y] = visualToPage(rect, rot, pad, pad + size * 0.85 + i * lineHeight);
    page.drawText(line, { x, y, size, font, color: hex(color), rotate: degrees(rot) });
  });
}

function drawImageIn(page: PDFPage, img: PDFImage, rect: Rect, rot: number) {
  const vis = visualSize(rect, rot);
  const [x, y] = visualToPage(rect, rot, 0, vis.h); // visual bottom-left
  page.drawImage(img, { x, y, width: vis.w, height: vis.h, rotate: degrees(rot) });
}

function dataUrlBytes(dataUrl: string): { bytes: Uint8Array; png: boolean } {
  const [head, b64 = ""] = dataUrl.split(",", 2);
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, png: head!.includes("image/png") };
}

function applyForm(doc: PDFDocument, values: DocModel["form"]): boolean {
  const names = Object.keys(values);
  if (names.length === 0) return false;
  const form = doc.getForm();
  for (const name of names) {
    const value = values[name]!;
    try {
      const field = form.getField(name);
      if (field instanceof PDFTextField) field.setText(String(value));
      else if (field instanceof PDFCheckBox) (value === true || value === "true" ? field.check() : field.uncheck());
      else if (field instanceof PDFDropdown || field instanceof PDFOptionList) field.select(String(value));
      else if (field instanceof PDFRadioGroup) field.select(String(value));
    } catch {
      // Unknown field or invalid option: skip it rather than fail the export.
    }
  }
  return true;
}

type Placed = DocModel["annotations"][number];
type ReplaceAnnot = Extract<Annotation, { kind: "replace" }>;

/**
 * Delete the original glyphs behind every "replace" annotation on the given
 * source pages. Returns the ids of edits whose text couldn't be found in the
 * page's own content (e.g. it sits in a Form XObject) — those get covered.
 */
function removeEditedText(doc: PDFDocument, entries: Array<{ index: number; annots: Placed[] }>, scanned: Set<string>): Set<string> {
  const incomplete = new Set<string>();
  for (const { index, annots } of entries) {
    const groups = annots.map((a) => ({ id: a.id, rects: (a.annot as ReplaceAnnot).cover }));
    let removed: Record<string, number> = {};
    let invisible: Record<string, number> = {};
    try {
      ({ removed, invisible } = removeTextFromPageDetailed(doc, doc.getPage(index), groups));
    } catch {
      removed = {};
    }
    for (const a of annots) {
      const expected = (a.annot as ReplaceAnnot).original.replace(/\s/g, "").length;
      const got = removed[a.id] ?? 0;
      if (got < Math.max(1, Math.floor(expected * 0.5))) incomplete.add(a.id);
      // OCR text is invisible: the words you see are pixels of the scan, so cover them.
      else if ((invisible[a.id] ?? 0) * 2 >= got) scanned.add(a.id);
    }
  }
  return incomplete;
}

function replaceTargets(model: DocModel, match: (src: PageEntry["source"]) => number | null) {
  const byIndex = new Map<number, Placed[]>();
  for (const a of model.annotations) {
    if (a.annot.kind !== "replace") continue;
    const entry = model.pages.find((p) => p.ref === a.page);
    const idx = entry ? match(entry.source) : null;
    if (idx === null) continue;
    byIndex.set(idx, [...(byIndex.get(idx) ?? []), a]);
  }
  return [...byIndex].map(([index, annots]) => ({ index, annots }));
}

export async function exportPdf({ base, ops, external = {}, loadFont, onWarning, ocr, redactImages = [] }: ExportInput): Promise<Uint8Array> {
  const src = await load(base);
  const model = deriveModel(src.getPageCount(), ops);
  const redactions = redactionsByPage(model);
  const redacting = redactions.size > 0;
  const hasForm = applyForm(src, model.form);
  if (redacting) {
    // Form fields keep their values outside the page; flatten them into the page so redaction reaches them.
    try { src.getForm().flatten(); } catch { /* no AcroForm */ }
    applyRedactedImages(src, "base", redactImages);
  }
  // Edited text: remove originals from the source pages before they're copied anywhere.
  const scanned = new Set<string>();
  const incomplete = removeEditedText(src, replaceTargets(model, (s) => (s.kind === "base" ? s.index : null)), scanned);

  let out: PDFDocument;
  const pagesByRef = new Map<string, PDFPage>();

  if (!model.structureChanged) {
    out = src;
    src.getPages().forEach((p, i) => pagesByRef.set(model.pages[i]!.ref, p));
  } else {
    if (hasForm) {
      try { src.getForm().flatten(); } catch { /* no AcroForm */ }
    }
    out = await PDFDocument.create();
    const title = src.getTitle();
    if (title) out.setTitle(title);

    // Copy pages per source in one call each, then add them in model order.
    const baseIdx = model.pages.flatMap((p) => (p.source.kind === "base" ? [p.source.index] : []));
    const baseCopies = new Map<number, PDFPage>();
    (await out.copyPages(src, baseIdx)).forEach((p, i) => baseCopies.set(baseIdx[i]!, p));

    const extCopies = new Map<string, PDFPage>();
    for (const versionId of model.externalVersions) {
      const bytes = external[versionId];
      if (!bytes) throw new ExportError("MISSING_EXTERNAL", `Missing merged file ${versionId}`);
      const extDoc = await load(bytes);
      if (redacting) {
        try { extDoc.getForm().flatten(); } catch { /* no AcroForm */ }
        applyRedactedImages(extDoc, versionId, redactImages);
      }
      for (const id of removeEditedText(extDoc, replaceTargets(model, (s) => (s.kind === "ext" && s.versionId === versionId ? s.index : null)), scanned)) incomplete.add(id);
      const idx = model.pages.flatMap((p) => (p.source.kind === "ext" && p.source.versionId === versionId ? [p.source.index] : []));
      const copies = await out.copyPages(extDoc, idx);
      copies.forEach((p, i) => extCopies.set(`${versionId}:${idx[i]}`, p));
    }

    for (const entry of model.pages) {
      let page: PDFPage;
      if (entry.source.kind === "base") page = out.addPage(baseCopies.get(entry.source.index)!);
      else if (entry.source.kind === "ext") page = out.addPage(extCopies.get(`${entry.source.versionId}:${entry.source.index}`)!);
      else page = out.addPage([entry.source.w, entry.source.h]);
      if (entry.rotation) page.setRotation(degrees((page.getRotation().angle + entry.rotation) % 360));
      pagesByRef.set(entry.ref, page);
    }
  }

  const fonts = new Map<FontName, PDFFont>();
  const font = async (name: FontName) => {
    let f = fonts.get(name);
    if (!f) fonts.set(name, (f = await out.embedFont(FONT_MAP[name])));
    return f;
  };
  const faces = new Map<string, PDFFont>();
  const faceFont = async (face: Face, bold: boolean, italic: boolean): Promise<PDFFont> => {
    const key = `${face}:${bold}:${italic}`;
    let f = faces.get(key);
    if (f) return f;
    const file = faceFile(face, bold, italic);
    if (file && loadFont) {
      try {
        out.registerFontkit(fontkit);
        f = await out.embedFont(await loadFont(file), { subset: true });
      } catch {
        f = undefined;
      }
    }
    if (!f) {
      const fallback: Face = face === "Caladea" ? "TimesRoman" : face === "Carlito" ? "Helvetica" : face;
      f = await out.embedFont(STANDARD_FACES[fallback as "Helvetica" | "TimesRoman" | "Courier"][(bold ? 1 : 0) + (italic ? 2 : 0)]!);
    }
    faces.set(key, f);
    return f;
  };
  const images = new Map<string, PDFImage>();
  const image = async (dataUrl: string) => {
    let img = images.get(dataUrl);
    if (!img) {
      const { bytes, png } = dataUrlBytes(dataUrl);
      img = png ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      images.set(dataUrl, img);
    }
    return img;
  };

  for (const { id, page: ref, annot } of model.annotations) {
    const page = pagesByRef.get(ref);
    if (!page || annot.kind === "redact") continue;
    // Pictures placed over a redaction would survive it (they're added after): leave them out.
    if ((annot.kind === "image" || annot.kind === "signature") && redactions.get(ref)?.some((r) => overlaps(annot.rect, r))) continue;
    if (annot.kind === "replace") {
      await drawReplace(page, annot, incomplete.has(id) || scanned.has(id), faceFont);
      continue;
    }
    const rot = page.getRotation().angle % 360;
    await drawAnnotation(page, annot, rot, font, image);
  }
  if (ocr) {
    for (const [ref, lines] of Object.entries(ocr)) {
      const page = pagesByRef.get(ref);
      if (!page || !lines.length) continue;
      try { removeOcrLayer(out, page, OCR_FONT_NAME); } catch { /* keep the old layer rather than fail the save */ }
      drawOcrLayer(out, page, lines);
    }
  }
  // Watermark and other page stamps, on the pages in their final order.
  await drawStamps(out, model.pages.flatMap((p) => { const pg = pagesByRef.get(p.ref); return pg ? [pg] : []; }), model, onWarning);

  // Redact last, so nothing drawn above (edited text, OCR text, stamps) survives under a mark.
  if (redacting) {
    const total: RedactStats = { glyphs: 0, paths: 0, inlineImages: 0, imagesCleaned: 0, imagesRemoved: 0, forms: 0, annots: 0 };
    for (const [ref, rects] of redactions) {
      const page = pagesByRef.get(ref);
      if (!page) continue;
      const st = redactPage(out, page, rects);
      for (const k of Object.keys(total) as Array<keyof RedactStats>) total[k] += st[k];
    }
    if (total.imagesRemoved) {
      onWarning?.(`${total.imagesRemoved === 1 ? "An image" : `${total.imagesRemoved} images`} under a redaction couldn't be edited, so ${total.imagesRemoved === 1 ? "it was" : "they were"} removed entirely.`);
    }
  }
  if (incomplete.size) {
    onWarning?.(
      incomplete.size === 1
        ? "One edited block's original text couldn't be removed from the file, so it was covered instead."
        : `${incomplete.size} edited blocks' original text couldn't be removed from the file, so it was covered instead.`,
    );
  }

  return out.save();
}

const STANDARD_FACES = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  TimesRoman: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
} as const;

async function drawReplace(page: PDFPage, a: ReplaceAnnot, cover: boolean, faceFont: (f: Face, b: boolean, i: boolean) => Promise<PDFFont>) {
  if (cover) {
    const pad = 0.6; // same as the editor preview
    for (const r of a.cover) page.drawRectangle({ x: r.x - pad, y: r.y - pad, width: r.w + pad * 2, height: r.h + pad * 2, color: hex(a.bg) });
  }
  const font = await faceFont(a.face, a.bold, a.italic);
  const text = sanitize(a.text, font);
  const rot = a.rotation ?? 0;
  const lines = layoutReplaceLines(text, (s) => font.widthOfTextAtSize(s, a.size), Math.max(visualSize(a.rect, rot).w, a.size));
  lines.forEach((line, i) => {
    if (!line) return;
    const [x, y] = visualToPage(a.rect, rot, 0, a.firstBaseline + i * a.lineHeight);
    page.drawText(line, { x, y, size: a.size, font, color: hex(a.color), ...(rot ? { rotate: degrees(rot) } : {}) });
  });
}

async function drawAnnotation(
  page: PDFPage,
  a: Annotation,
  rot: number,
  font: (n: FontName) => Promise<PDFFont>,
  image: (d: string) => Promise<PDFImage>,
) {
  switch (a.kind) {
    case "text":
      drawTextBlock(page, a.rect, rot, a.text, await font(a.font), a.size, a.color);
      break;
    case "highlight":
      page.drawRectangle({ x: a.rect.x, y: a.rect.y, width: a.rect.w, height: a.rect.h, color: hex(a.color), opacity: 0.4, blendMode: BlendMode.Multiply });
      break;
    case "whiteout":
      page.drawRectangle({ x: a.rect.x, y: a.rect.y, width: a.rect.w, height: a.rect.h, color: rgb(1, 1, 1) });
      break;
    case "rect":
      page.drawRectangle({
        x: a.rect.x, y: a.rect.y, width: a.rect.w, height: a.rect.h,
        borderColor: hex(a.stroke), borderWidth: a.width,
        ...(a.fill ? { color: hex(a.fill) } : {}),
      });
      break;
    case "ellipse":
      page.drawEllipse({
        x: a.rect.x + a.rect.w / 2, y: a.rect.y + a.rect.h / 2,
        xScale: a.rect.w / 2, yScale: a.rect.h / 2,
        borderColor: hex(a.stroke), borderWidth: a.width,
        ...(a.fill ? { color: hex(a.fill) } : {}),
      });
      break;
    case "line":
    case "arrow": {
      const color = hex(a.stroke);
      const [x1, y1] = a.from;
      const [x2, y2] = a.to;
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: a.width, color, lineCap: LineCapStyle.Round });
      if (a.kind === "arrow") {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const len = Math.max(8, a.width * 4);
        for (const side of [-1, 1]) {
          const t = ang + Math.PI - side * (Math.PI / 7);
          page.drawLine({ start: { x: x2, y: y2 }, end: { x: x2 + len * Math.cos(t), y: y2 + len * Math.sin(t) }, thickness: a.width, color, lineCap: LineCapStyle.Round });
        }
      }
      break;
    }
    case "ink": {
      const color = hex(a.color);
      for (const s of a.strokes) {
        if (s.length < 4) continue;
        let d = `M ${s[0]} ${-s[1]!}`;
        for (let i = 2; i + 1 < s.length; i += 2) d += ` L ${s[i]} ${-s[i + 1]!}`;
        // drawSvgPath uses SVG's y-down axis from (x, y); negate y to stay in PDF space.
        page.drawSvgPath(d, { x: 0, y: 0, borderColor: color, borderWidth: a.width, borderLineCap: LineCapStyle.Round });
      }
      break;
    }
    case "image":
    case "signature":
      drawImageIn(page, await image(a.dataUrl), a.rect, rot);
      break;
    case "note": {
      const [x, y] = a.at;
      const icon = 14;
      page.drawRectangle({ x, y: y - icon, width: icon, height: icon, color: rgb(0.98, 0.8, 0.08), borderColor: rgb(0.44, 0.25, 0.07), borderWidth: 0.6 });
      if (a.text.trim()) {
        const f = await font("Helvetica");
        const box: Rect = { x: x + icon + 4, y: y - 60, w: 160, h: 60 };
        page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, color: rgb(1, 0.98, 0.86), borderColor: rgb(0.91, 0.84, 0.54), borderWidth: 0.6, opacity: 0.95 });
        drawTextBlock(page, box, rot, a.text, f, 8, "#3F3F46", 4);
      }
      break;
    }
  }
}
