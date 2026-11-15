import { describe, expect, it } from "vitest";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { exportPdf } from "../src/export";
import type { OcrLine } from "../src/ocr";

type Item = { str: string; t: number[]; w: number; font: string };

async function textItems(bytes: Uint8Array): Promise<{ items: Item[]; fontNames: string[] }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), fontExtraProperties: true, disableFontFace: true, useSystemFonts: false });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  await page.getOperatorList();
  const tc = await page.getTextContent();
  const items = (tc.items as Array<{ str: string; transform: number[]; width: number; fontName: string }>)
    .filter((i) => i.str.trim())
    .map((i) => ({ str: i.str, t: i.transform, w: i.width, font: i.fontName }));
  const fontNames = [...new Set(items.map((i) => i.font))].map((f) => (page.commonObjs.has(f) ? (page.commonObjs.get(f) as { name: string }).name : f));
  await task.destroy();
  return { items, fontNames };
}

/** A "scan": one page with a grey image-like rectangle and no text. */
async function scanPdf(rotate = 0) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.97, 0.96, 0.93) });
  if (rotate) page.setRotation(degrees(rotate));
  return doc.save();
}

const line = (words: Array<[string, number, number]>, y: number, size = 12): OcrLine => ({
  dir: [1, 0],
  words: words.map(([text, x, w]) => ({ text, x, y, w, size })),
});

describe("OCR text layer", () => {
  it("adds invisible, searchable text in English and Hindi at the recognised positions", async () => {
    const out = await exportPdf({
      base: await scanPdf(),
      ops: [],
      ocr: {
        p1: [
          line([["Invoice", 72, 48], ["total", 124, 30], ["₹1,24,500", 158, 62]], 700),
          line([["नमस्ते", 72, 44], ["दुनिया", 120, 46]], 680, 14),
        ],
      },
    });
    const { items, fontNames } = await textItems(out);
    const text = items.map((i) => i.str).join(" ");
    expect(text).toContain("Invoice");
    expect(text).toContain("₹1,24,500");
    expect(text).toContain("नमस्ते");
    expect(text).toContain("दुनिया");
    expect(fontNames).toContain("PDFInkly-OCR");
    const inv = items.find((i) => i.str.startsWith("Invoice"))!;
    expect(inv.t[4]).toBeCloseTo(72, 1);
    expect(inv.t[5]).toBeCloseTo(700, 1);
    expect(inv.t[3]).toBeCloseTo(12, 1); // font size → item height
  });

  it("places text along the reading direction on rotated pages", async () => {
    // Page shown rotated 90°: upright text runs "up" the unrotated page (+y).
    const out = await exportPdf({
      base: await scanPdf(90),
      ops: [],
      ocr: { p1: [{ dir: [0, 1], words: [{ text: "Sideways", x: 300, y: 100, w: 60, size: 12 }] }] },
    });
    const { items } = await textItems(out);
    const it0 = items.find((i) => i.str.includes("Sideways"))!;
    expect(it0).toBeTruthy();
    expect(it0.t[0]).toBeCloseTo(0, 3);
    expect(it0.t[1]).toBeGreaterThan(0); // direction along +y
    expect(it0.t[4]).toBeCloseTo(300, 1);
    expect(it0.t[5]).toBeCloseTo(100, 1);
  });

  it("lets Edit text replace OCR text: removes the invisible words and covers the scan", async () => {
    const withOcr = await exportPdf({
      base: await scanPdf(),
      ops: [],
      ocr: { p1: [line([["Total", 72, 32], ["due:", 108, 26]], 700), line([["Keep", 72, 30], ["this", 106, 24]], 660)] },
    });
    const warnings: string[] = [];
    const out = await exportPdf({
      base: withOcr,
      onWarning: (w) => warnings.push(w),
      ops: [{
        op: "annot.add", id: "r", page: "p1", annot: {
          kind: "replace", rect: { x: 72, y: 697, w: 62, h: 12 }, cover: [{ x: 72, y: 697.6, w: 62, h: 12 }],
          text: "Balance:", original: "Total due:", face: "Helvetica", bold: false, italic: false, size: 12,
          color: "#111111", bg: "#F7F5ED", lineHeight: 14, firstBaseline: 9.6, srcFont: "PDFInkly-OCR",
        },
      }],
    });
    expect(warnings).toEqual([]);
    const text = (await textItems(out)).items.map((i) => i.str).join(" ");
    expect(text).toContain("Balance:");
    expect(text).not.toContain("Total");
    expect(text).toContain("Keep");
    // The cover (paper colour) is drawn because the removed glyphs were invisible OCR text.
    const doc = await PDFDocument.load(out);
    const { pageContent } = await import("../src/pdftext");
    const content = new TextDecoder("latin1").decode(pageContent(doc.getPage(0)));
    expect(content).toMatch(/0\.96\d* 0\.9[56]\d* 0\.9\d* rg/); // #F7F5ED fill
  });

  it("recognising again replaces the old OCR layer instead of adding a second one", async () => {
    const first = await exportPdf({ base: await scanPdf(), ops: [], ocr: { p1: [line([["J0nk", 72, 40], ["w0rds", 116, 40]], 700)] } });
    const again = await exportPdf({ base: first, ops: [], ocr: { p1: [line([["Real", 72, 30], ["words", 106, 36]], 700)] } });
    const { items } = await textItems(again);
    const text = items.map((i) => i.str).join(" ");
    expect(text).toContain("Real");
    expect(text).toContain("words");
    expect(text).not.toContain("J0nk");
    expect(text).not.toContain("w0rds");
    // Other text on the page is untouched.
    const doc = await PDFDocument.load(again);
    const font = await doc.embedFont("Helvetica");
    doc.getPage(0).drawText("Typed", { x: 72, y: 500, size: 12, font });
    const third = await exportPdf({ base: await doc.save(), ops: [], ocr: { p1: [line([["Final", 72, 30]], 700)] } });
    const t3 = (await textItems(third)).items.map((i) => i.str).join(" ");
    expect(t3).toContain("Typed");
    expect(t3).toContain("Final");
    expect(t3).not.toContain("Real");
  });

  it("edits text on a rotated page in the reading direction", async () => {
    // Page shown rotated 90°; OCR text runs up the unrotated page.
    const withOcr = await exportPdf({
      base: await scanPdf(90),
      ops: [],
      ocr: { p1: [{ dir: [0, 1], words: [{ text: "Engineer", x: 300, y: 100, w: 60, size: 12 }, { text: "Keep", x: 300, y: 200, w: 30, size: 12 }] }] },
    });
    // As seen upright: the word's box spans x 290.4..302.4 (descent below the baseline is +x), y 100..160.
    const out = await exportPdf({
      base: withOcr,
      ops: [{
        op: "annot.add", id: "r", page: "p1", annot: {
          kind: "replace", rect: { x: 290.4, y: 100, w: 12, h: 60 }, cover: [{ x: 290.4, y: 99, w: 12, h: 62 }],
          text: "Developer", original: "Engineer", face: "Helvetica", bold: false, italic: false, size: 12,
          color: "#111111", bg: "#FFFFFF", lineHeight: 14, firstBaseline: 9.6, srcFont: "PDFInkly-OCR", rotation: 90,
        },
      }],
    });
    const { items } = await textItems(out);
    const text = items.map((i) => i.str).join(" ");
    expect(text).toContain("Developer");
    expect(text).not.toContain("Engineer");
    expect(text).toContain("Keep");
    const dev = items.find((i) => i.str.includes("Developer"))!;
    expect(dev.t[0]).toBeCloseTo(0, 3);
    expect(dev.t[1]).toBeCloseTo(12, 1); // runs along +y like the original
    expect(dev.t[4]).toBeCloseTo(300, 1); // on the original baseline (x = 290.4 + 9.6)
    expect(dev.t[5]).toBeCloseTo(100, 1);
  });
});

