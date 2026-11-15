import { PDFDocument } from "pdf-lib";

/** One picture to place on its own page: JPEG or PNG bytes and its pixel size (orientation already applied). */
export interface PageImage {
  bytes: Uint8Array;
  type: "jpg" | "png";
  width: number;
  height: number;
}

export interface ImagesToPdfOptions {
  /** A4 or Letter (turned to match each picture's orientation), or a page the picture's size. */
  pageSize: "a4" | "letter" | "fit";
  /** White space around the picture on A4/Letter pages, points. */
  margin: number;
  title?: string;
  /** For "fit": pixels per inch of the pictures (default 150). */
  dpi?: number;
  /** For "fit": make every page's longer side this many points instead (proportions kept). */
  fitLongSide?: number;
}

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;

/** Make a PDF with one page per picture, each scaled to fit and centred. */
export async function imagesToPdf(images: readonly PageImage[], opts: ImagesToPdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (opts.title) doc.setTitle(opts.title);
  doc.setProducer("PDFInkly");
  for (const img of images) {
    const embedded = img.type === "png" ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
    const landscape = img.width > img.height;
    let pw: number, ph: number, margin: number;
    if (opts.pageSize === "fit") {
      // The picture's own size at 150 dpi (so phone photos don't make metre-wide pages), no margin.
      const k = opts.fitLongSide ? opts.fitLongSide / Math.max(img.width, img.height) : 72 / (opts.dpi ?? 150);
      [pw, ph, margin] = [Math.max(72, img.width * k), Math.max(72, img.height * k), 0];
    } else {
      const [w, h] = SIZES[opts.pageSize];
      [pw, ph] = landscape ? [h, w] : [w, h];
      margin = Math.max(0, Math.min(opts.margin, Math.min(pw, ph) / 4));
    }
    const s = Math.min((pw - 2 * margin) / img.width, (ph - 2 * margin) / img.height);
    const w = img.width * s, h = img.height * s;
    const page = doc.addPage([pw, ph]);
    page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return doc.save();
}
