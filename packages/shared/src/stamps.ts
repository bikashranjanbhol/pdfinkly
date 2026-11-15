import { PDFArray, PDFName, StandardFonts, degrees, rgb, type PDFDocument, type PDFFont, type PDFImage, type PDFPage, type PDFRef } from "pdf-lib";
import type { DocModel, Watermark } from "./operations";
import { parsePageRange, startFor, watermarkCentres } from "./stampLayout";
import { fromTextFrame } from "./visual";

export { parsePageRange } from "./stampLayout";

const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

/** Make pdf-lib start a fresh content stream on its next draw call. */
function freshStream(page: PDFPage) {
  const cached = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown };
  cached.contentStream = undefined;
  cached.contentStreamRef = undefined;
}

/** Move the stream pdf-lib just drew into to the front of /Contents (behind everything). */
function sendToBack(page: PDFPage) {
  const ref = (page as unknown as { contentStreamRef?: PDFRef }).contentStreamRef;
  const contents = page.node.Contents();
  if (!ref || !(contents instanceof PDFArray)) return;
  const items = contents.asArray().filter((r) => r !== ref);
  page.node.set(PDFName.of("Contents"), page.doc.context.obj([ref, ...items]));
}

/** The page as displayed: width/height and how to map visual (y-up) points to PDF space. */
function visualFrame(page: PDFPage) {
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const box = page.getCropBox();
  const W = rot % 180 ? box.height : box.width;
  const H = rot % 180 ? box.width : box.height;
  // Visual y-up frame = the text frame for `rot`, shifted so the page's corner is (0, 0).
  const corner: Record<number, [number, number]> = { 0: [box.x, box.y], 90: [box.x + box.width, box.y], 180: [box.x + box.width, box.y + box.height], 270: [box.x, box.y + box.height] };
  const [ox, oy] = corner[rot]!;
  const toPdf = (x: number, y: number): [number, number] => {
    const [dx, dy] = fromTextFrame(rot, x, y);
    return [ox + dx, oy + dy];
  };
  return { rot, W, H, toPdf };
}

async function embedImage(doc: PDFDocument, dataUrl: string): Promise<PDFImage> {
  const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]!), (c) => c.charCodeAt(0));
  return dataUrl.startsWith("data:image/png") ? doc.embedPng(bytes) : doc.embedJpg(bytes);
}

/** Keep only characters the standard fonts can draw (WinAnsi). */
const winAnsi = (font: PDFFont, s: string) => Array.from(s).filter((c) => { try { font.encodeText(c); return true; } catch { return false; } }).join("");

/** Draw a watermark on one page. */
export async function drawWatermark(doc: PDFDocument, page: PDFPage, wm: Watermark, cache: { font?: PDFFont; image?: PDFImage }) {
  const { rot, W, H, toPdf } = visualFrame(page);
  if (wm.layer === "under") freshStream(page);

  if (wm.image) {
    cache.image ??= await embedImage(doc, wm.image);
    const w = (W * wm.size) / 100;
    const h = (w * cache.image.height) / cache.image.width;
    for (const [cx, cy] of watermarkCentres(wm.layout, W, H, w, h, wm.angle)) {
      const [x, y] = toPdf(...startFor(cx, cy, w, h, wm.angle));
      page.drawImage(cache.image, { x, y, width: w, height: h, opacity: wm.opacity, rotate: degrees(rot + wm.angle) });
    }
  }
  const text = wm.text.trim();
  if (text) {
    cache.font ??= await doc.embedFont(wm.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
    const font = cache.font;
    const safe = winAnsi(font, text);
    const w = font.widthOfTextAtSize(safe, wm.size);
    const h = font.heightAtSize(wm.size, { descender: false });
    for (const [cx, cy] of watermarkCentres(wm.layout, W, H, w, h, wm.angle)) {
      const [x, y] = toPdf(...startFor(cx, cy, w, h, wm.angle));
      page.drawText(safe, { x, y, size: wm.size, font, color: hex(wm.color), opacity: wm.opacity, rotate: degrees(rot + wm.angle) });
    }
  }

  if (wm.layer === "under") {
    sendToBack(page);
    freshStream(page);
  }
}

/** Draw every stamp in the model on the pages it applies to (in final page order). */
export async function drawStamps(doc: PDFDocument, pages: PDFPage[], model: DocModel, onWarning?: (w: string) => void) {
  const wm = model.stamps.watermark;
  if (wm && (wm.text.trim() || wm.image)) {
    const which = parsePageRange(wm.pages, pages.length) ?? new Set<number>();
    const cache: { font?: PDFFont; image?: PDFImage } = {};
    for (const [i, page] of pages.entries()) if (which.has(i + 1)) await drawWatermark(doc, page, wm, cache);
    if (cache.font && winAnsi(cache.font, wm.text) !== wm.text) onWarning?.("Some watermark characters (e.g. Hindi) can't be drawn with the watermark font yet and were left out.");
  }
}
