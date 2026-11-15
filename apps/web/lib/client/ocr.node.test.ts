import { mkdtempSync, copyFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorker, type Worker } from "tesseract.js";
import { exportPdf } from "@pdfinkly/shared/export";
import { blocksToLines } from "./ocrMap";

/**
 * Real Tesseract (same engine and language packs the browser uses) on scanned
 * fixtures: recognise, map to PDF space, write the text layer, read it back.
 */
const require = createRequire(import.meta.url);
const FIX = path.join(__dirname, "../../../../packages/shared/test/fixtures");
const DPI = 200; // the fixtures' images were rasterised at 200 dpi
const k = DPI / 72;
const view: [number, number, number, number] = [0, 0, 595.28, 841.89];

let langDir = "";
beforeAll(() => {
  langDir = mkdtempSync(path.join(os.tmpdir(), "tess-"));
  for (const l of ["eng", "hin"]) {
    const dir = path.dirname(require.resolve(`@tesseract.js-data/${l}/package.json`));
    copyFileSync(path.join(dir, "4.0.0_best_int", `${l}.traineddata.gz`), path.join(langDir, `${l}.traineddata.gz`));
  }
});

let worker: Worker | null = null;
afterAll(async () => { await worker?.terminate(); });

async function recognise(file: string, langs: string[]) {
  worker?.terminate();
  worker = await createWorker(langs, 1, { langPath: langDir, cachePath: langDir, gzip: true });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // The fixture page is one JPEG; give Tesseract that image directly (the browser renders the page instead).
  const bytes = new Uint8Array(readFileSync(path.join(FIX, file)));
  const { PDFDocument, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  const xobjs = doc.getPage(0).node.Resources()!.lookup(PDFName.of("XObject")) as import("pdf-lib").PDFDict;
  const img = xobjs.lookup(xobjs.keys()[0]!) as unknown as { contents: Uint8Array };
  const { data } = await worker.recognize(Buffer.from(img.contents), {}, { blocks: true, text: true });
  void pdfjs;
  return { bytes, data };
}

async function readBack(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false });
  const page = await (await task.promise).getPage(1);
  const tc = await page.getTextContent();
  const items = (tc.items as Array<{ str: string; transform: number[] }>).filter((i) => i.str.trim());
  await task.destroy();
  return items;
}

describe("OCR with Tesseract (node)", () => {
  it("English scan: words land on the original baselines at the original size", async () => {
    const { bytes, data } = await recognise("scan-en.pdf", ["eng"]);
    const lines = blocksToLines(data.blocks, { pxPerPt: k, view, rotate: 0 });
    const out = await exportPdf({ base: bytes, ops: [], ocr: { p1: lines } });
    const items = await readBack(out);
    const text = items.map((i) => i.str).join(" ");
    for (const s of ["Aditi", "Sharma", "Product", "designer", "payments", "dashboard", "Invoice", "INV-2026-0042"]) expect(text).toContain(s);

    // Compare with the born-digital original the scan was made from (0.6° skew, so allow a few points).
    const orig = await readBack(new Uint8Array(readFileSync(path.join(FIX, "chrome-cid.pdf"))));
    const product = items.find((i) => i.str.startsWith("Product"))!;
    const productOrig = orig.find((i) => i.str.startsWith("Product"))!;
    expect(Math.abs(product.transform[4]! - productOrig.transform[4]!)).toBeLessThan(4);
    expect(Math.abs(product.transform[5]! - productOrig.transform[5]!)).toBeLessThan(4);
    const sizeRatio = product.transform[3]! / productOrig.transform[3]!;
    expect(sizeRatio).toBeGreaterThan(0.88);
    expect(sizeRatio).toBeLessThan(1.1);
  }, 120_000);

  it("Hindi + English scan: Devanagari text is searchable and copyable", async () => {
    const { bytes, data } = await recognise("scan-hi.pdf", ["hin", "eng"]);
    const lines = blocksToLines(data.blocks, { pxPerPt: k, view, rotate: 0 });
    const out = await exportPdf({ base: bytes, ops: [], ocr: { p1: lines } });
    const text = (await readBack(out)).map((i) => i.str).join(" ");
    for (const s of ["राशि", "भुगतान", "दिनों", "Invoice", "2026-0042"]) expect(text).toContain(s);
  }, 120_000);
});

describe("Edit text on OCR output", () => {
  it("groups recognised words into paragraphs and replaces one cleanly", async () => {
    const { textBlocks } = await import("../../components/editor/textBlocks");
    const { matchFont, OCR_FONT_NAME } = await import("@pdfinkly/shared");
    const { bytes, data } = await recognise("scan-en.pdf", ["eng"]);
    const ocred = await exportPdf({ base: bytes, ops: [], ocr: { p1: blocksToLines(data.blocks, { pxPerPt: k, view, rotate: 0 }) } });

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: ocred.slice(), fontExtraProperties: true, disableFontFace: true, useSystemFonts: false });
    const blocks = await textBlocks(await (await task.promise).getPage(1));
    await task.destroy();

    const para = blocks.find((b) => b.text.startsWith("Product designer"))!;
    expect(para, blocks.map((b) => b.text.slice(0, 30)).join(" | ")).toBeTruthy();
    expect(para.lines.length).toBe(2);
    expect(para.font.raw).toBe(OCR_FONT_NAME);
    expect(para.text).toMatch(/^Product designer with 6 years of experience building accessible web apps/);
    expect(para.size).toBeGreaterThan(9.5);
    expect(para.size).toBeLessThan(12);

    const m = para.font.raw === OCR_FONT_NAME ? { face: "Helvetica" as const } : matchFont(para.font.raw, para.font);
    const warnings: string[] = [];
    const out = await exportPdf({
      base: ocred, onWarning: (w) => warnings.push(w),
      ops: [{ op: "annot.add", id: "x", page: "p1", annot: {
        kind: "replace", rect: para.rect, cover: para.cover, text: "Rewritten from a scan.", original: para.text,
        face: m.face, bold: false, italic: false, size: para.size, color: "#222222", bg: "#F9F5EC",
        lineHeight: para.lineHeight, firstBaseline: para.firstBaseline, srcFont: para.font.raw,
      } }],
    });
    expect(warnings).toEqual([]);
    const text = (await readBack(out)).map((i) => i.str).join(" ");
    expect(text).toContain("Rewritten from a scan.");
    expect(text).not.toContain("healthcare");
    expect(text).toContain("Invoice");
  }, 120_000);
});
