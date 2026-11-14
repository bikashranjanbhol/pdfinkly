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
import { deriveModel, type Annotation, type DocModel, type FontName, type Operation, type Rect } from "./operations";

export interface ExportInput {
  /** Bytes of the base version the operations were made against. */
  base: Uint8Array;
  ops: readonly Operation[];
  /** Bytes of other versions merged in with page.insertFrom, keyed by version id. */
  external?: Record<string, Uint8Array>;
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

/**
 * Map a point given in "visual" coordinates (u to the right, v downward, from
 * the visual top-left of `rect` as seen with total rotation `rot`) into the
 * page's unrotated PDF space.
 */
export function visualToPage(rect: Rect, rot: number, u: number, v: number): [number, number] {
  const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.w, y1 = rect.y + rect.h;
  switch (((rot % 360) + 360) % 360) {
    case 90: return [x0 + v, y0 + u];
    case 180: return [x1 - u, y0 + v];
    case 270: return [x1 - v, y1 - u];
    default: return [x0 + u, y1 - v];
  }
}

/** Width and height of `rect` as seen on screen with rotation `rot`. */
export const visualSize = (rect: Rect, rot: number) =>
  rot % 180 === 0 ? { w: rect.w, h: rect.h } : { w: rect.h, h: rect.w };

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

export async function exportPdf({ base, ops, external = {} }: ExportInput): Promise<Uint8Array> {
  const src = await load(base);
  const model = deriveModel(src.getPageCount(), ops);
  const hasForm = applyForm(src, model.form);

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

  for (const { page: ref, annot } of model.annotations) {
    const page = pagesByRef.get(ref);
    if (!page) continue;
    const rot = page.getRotation().angle % 360;
    await drawAnnotation(page, annot, rot, font, image);
  }

  return out.save();
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
