import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, StandardFonts, rgb } from "pdf-lib";
import { exportPdf, planRedactionImages } from "../src/export";
import type { Operation, Rect } from "../src/operations";
import { pageContent } from "../src/pdftext";
import { findInRuns } from "../src/pii";

const FIX = path.join(__dirname, "fixtures");
const fixture = (f: string) => new Uint8Array(readFileSync(path.join(FIX, f)));

type Item = { str: string; t: number[]; w: number };
async function items(bytes: Uint8Array, pageNo = 1): Promise<Item[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false });
  const page = await (await task.promise).getPage(pageNo);
  const tc = await page.getTextContent();
  const out = (tc.items as Array<{ str: string; transform: number[]; width: number }>).filter((i) => i.str.trim()).map((i) => ({ str: i.str, t: i.transform, w: i.width }));
  await task.destroy();
  return out;
}
const textOf = async (bytes: Uint8Array) => (await items(bytes)).map((i) => i.str).join(" ").replace(/\s+/g, " ");

/** Box around `needle` on the page, found the way the editor's Find does. */
async function boxOf(bytes: Uint8Array, needle: string): Promise<Rect> {
  const all = await items(bytes);
  const [m] = findInRuns(all.map((i) => ({ str: i.str, transform: i.t, width: i.w })), ["custom"], needle);
  if (!m) throw new Error(`"${needle}" not found in: ${all.map((i) => i.str).join(" | ")}`);
  return m.rect;
}

const redact = (rect: Rect, page = "p1", id = "r1"): Operation => ({ op: "annot.add", id, page, annot: { kind: "redact", rect } });
const content = async (bytes: Uint8Array) => new TextDecoder("latin1").decode(pageContent((await PDFDocument.load(bytes)).getPage(0)));

describe("redaction: text in real-world PDFs", () => {
  for (const [file, secret, keep] of [
    ["chrome-cid.pdf", "98765 43210", "Aditi Sharma"],
    ["letter-libreoffice.pdf", "3 November 2026", "Dear Mr. Rao"],
    ["report-pdflatex.pdf", "18%", "Quarterly Report"],
    ["resume-wkhtmltopdf.pdf", "aditi.sharma@example.com", "Product"],
  ] as const) {
    it(`${file}: deletes "${secret}", keeps the rest, draws a black box`, async () => {
      const base = fixture(file);
      const rect = await boxOf(base, secret);
      const out = await exportPdf({ base, ops: [redact(rect)] });
      const text = await textOf(out);
      for (const part of secret.split(/\s+/).filter((p) => p.length >= 3)) expect(text, text).not.toContain(part);
      expect(text).toContain(keep);
      expect(await content(out)).toMatch(/0 0 0 rg/);
    });
  }
});

describe("redaction: everything under the box goes", () => {
  it("vector drawings inside the box are deleted; ones crossing it stay", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    page.drawRectangle({ x: 110, y: 110, width: 20, height: 20, color: rgb(0.8, 0.1, 0.1) }); // inside
    page.drawLine({ start: { x: 0, y: 120 }, end: { x: 400, y: 120 }, thickness: 1 }); // crosses
    const out = await exportPdf({ base: await doc.save(), ops: [redact({ x: 100, y: 100, w: 50, h: 50 })] });
    const c = await content(out);
    expect(c).not.toMatch(/0 20 l\s+20 20 l/); // the small square's path is gone
    expect(c).toMatch(/400 120 l/);
  });

  it("text inside a form XObject is deleted", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontRef = font.ref;
    const form = doc.context.flateStream(new TextEncoder().encode("BT /F1 12 Tf 10 10 Td (SECRET 4321) Tj ET BT /F1 12 Tf 10 40 Td (Visible) Tj ET"), {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 100],
      Resources: { Font: { F1: fontRef } },
    });
    const formRef = doc.context.register(form);
    page.node.setXObject(PDFName.of("Fm1"), formRef);
    page.pushOperators(...[]);
    const raw = doc.context.flateStream(new TextEncoder().encode("q 1 0 0 1 100 100 cm /Fm1 Do Q"));
    page.node.set(PDFName.of("Contents"), doc.context.register(raw));
    const base = await doc.save();
    expect(await textOf(base)).toContain("SECRET");
    const out = await exportPdf({ base, ops: [redact({ x: 105, y: 105, w: 120, h: 18 })] });
    const text = await textOf(out);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("4321");
    expect(text).toContain("Visible");
  });

  it("form field values and link annotations under the box are removed", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const tf = doc.getForm().createTextField("pan");
    tf.setText("ABCDE1234F");
    tf.addToPage(page, { x: 100, y: 300, width: 150, height: 20 });
    const keep = doc.getForm().createTextField("name");
    keep.setText("Aditi");
    keep.addToPage(page, { x: 100, y: 100, width: 150, height: 20 });
    const link = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [100, 250, 200, 270], A: { S: "URI", URI: "https://secret.example" } }));
    const other = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 10, 50, 30], A: { S: "URI", URI: "https://ok.example" } }));
    (page.node.lookup(PDFName.of("Annots"), PDFArray)).push(link);
    (page.node.lookup(PDFName.of("Annots"), PDFArray)).push(other);
    const base = await doc.save();

    const out = await exportPdf({ base, ops: [redact({ x: 95, y: 245, w: 165, h: 80 })] });
    const saved = await PDFDocument.load(out);
    const uris = saved.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray().map((r) => {
      const a = saved.context.lookup(r) as PDFDict;
      return (a.lookupMaybe(PDFName.of("A"), PDFDict)?.get(PDFName.of("URI")) as { decodeText?: () => string } | undefined)?.decodeText?.() ?? "";
    }) ?? [];
    expect(uris.some((u) => u.includes("secret"))).toBe(false);
    expect(uris.some((u) => u.includes("ok.example"))).toBe(true);
    expect(saved.getForm().getFields().map((f) => f.getName())).not.toContain("pan");
    // Nothing anywhere in the file (decompressed) still holds the value.
    const everything = saved.context.enumerateIndirectObjects().map(([, o]) => (o instanceof PDFRawStream ? new TextDecoder("latin1").decode(o.getContents()) : o.toString())).join("\n");
    expect(everything).not.toContain("ABCDE1234F");
    const text = await textOf(out);
    expect(text).not.toContain("ABCDE1234F");
    expect(text).toContain("Aditi");
  });
});

describe("redaction: scanned pages", () => {
  async function scanWithOcr() {
    // scan-en.pdf + an OCR text layer, as PDFInkly saves it.
    return exportPdf({
      base: fixture("scan-en.pdf"), ops: [],
      ocr: { p1: [{ dir: [1, 0], words: [
        { text: "Phone:", x: 200, y: 760, w: 30, size: 9 }, { text: "+91", x: 233, y: 760, w: 16, size: 9 },
        { text: "98765", x: 252, y: 760, w: 28, size: 9 }, { text: "Keepme", x: 72, y: 700, w: 40, size: 9 },
      ] }] },
    });
  }
  const box: Rect = { x: 230, y: 755, w: 55, h: 14 };

  it("plans the scan image for pixel clean-up, with the box in image pixels", async () => {
    const base = await scanWithOcr();
    const jobs = await planRedactionImages({ base, ops: [redact(box)] });
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j.jpeg).toBe(true);
    expect(j.width).toBeGreaterThan(1000);
    const [x0, y0, x1, y1] = j.boxes[0]!;
    // 200 dpi scan of an A4 page: 1 pt ≈ 2.78 px; the box sits near the top.
    expect(x0 / j.width).toBeCloseTo(230 / 595.28, 1);
    expect(y0).toBeLessThan(j.height * 0.15);
    expect(x1 - x0).toBeGreaterThan(140);
    expect(y1 - y0).toBeGreaterThan(30);
    // The job's one-image PDF opens and has the image's size.
    const mini = await PDFDocument.load(j.pdf);
    expect(mini.getPage(0).getSize()).toEqual({ width: j.width, height: j.height });
  });

  it("swaps in the blacked-out image and deletes the OCR words under the box", async () => {
    const base = await scanWithOcr();
    const [job] = await planRedactionImages({ base, ops: [redact(box)] });
    // What the browser would send back: a grey image with the box filled black.
    const px = new Uint8Array(job!.width * job!.height).fill(255);
    const [x0, y0, x1, y1] = job!.boxes[0]!;
    for (let y = y0; y < y1; y++) px.fill(0, y * job!.width + x0, y * job!.width + x1);
    const out = await exportPdf({
      base, ops: [redact(box)],
      redactImages: [{ key: job!.key, width: job!.width, height: job!.height, gray: true, filter: "FlateDecode", data: new Uint8Array(deflateSync(px)) }],
    });
    const text = await textOf(out);
    expect(text).not.toContain("98765");
    expect(text).not.toContain("+91");
    expect(text).toContain("Keepme");

    const doc = await PDFDocument.load(out);
    const xo = doc.getPage(0).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const images = xo.keys().map((k) => xo.lookup(k)).filter((o): o is PDFStream => o instanceof PDFStream && o.dict.get(PDFName.of("Subtype"))?.toString() === "/Image");
    expect(images).toHaveLength(1);
    expect(images[0]!.dict.get(PDFName.of("PDFInklyRedacted"))?.toString()).toBe("true");
    expect(images[0]!.dict.get(PDFName.of("ColorSpace"))?.toString()).toBe("/DeviceGray");
    expect(await content(out)).toMatch(/Do/); // the image is still drawn
  });

  it("without a cleaned image, the image is removed rather than left readable", async () => {
    const base = await scanWithOcr();
    const warnings: string[] = [];
    const out = await exportPdf({ base, ops: [redact(box)], onWarning: (w) => warnings.push(w) });
    expect(warnings.join(" ")).toMatch(/removed entirely/);
    expect(await content(out)).not.toMatch(/\/\S+ Do/);
  });
});

void PDFRawStream; void PDFRef;
