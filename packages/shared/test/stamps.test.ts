import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { exportPdf } from "../src/export";
import type { HeaderFooter, Operation, Watermark } from "../src/operations";
import { parsePageRange } from "../src/stampLayout";

const FIX = path.join(__dirname, "fixtures");
const fixture = (f: string) => new Uint8Array(readFileSync(path.join(FIX, f)));

async function items(bytes: Uint8Array, pageNo = 1) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false });
  const doc = await task.promise;
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent();
  const out = (tc.items as Array<{ str: string; transform: number[]; width: number }>).filter((i) => i.str.trim());
  const n = doc.numPages;
  await task.destroy();
  return Object.assign(out, { pages: n });
}

const wm = (over: Partial<Watermark> = {}): Watermark => ({
  kind: "watermark", text: "CONFIDENTIAL", size: 48, bold: true, color: "#DC2626", opacity: 0.3, angle: 45,
  layout: "center", layer: "over", pages: "", ...over,
});
const set = (w: Watermark | null): Operation => ({ op: "stamp.set", key: "watermark", stamp: w });

describe("page ranges", () => {
  it("parses lists and open ranges, rejects nonsense", () => {
    expect([...parsePageRange("", 3)!]).toEqual([1, 2, 3]);
    expect([...parsePageRange("1-2, 5, 7-", 9)!]).toEqual([1, 2, 5, 7, 8, 9]);
    expect([...parsePageRange("-2", 5)!]).toEqual([1, 2]);
    expect(parsePageRange("3-1", 5)).toBeNull();
    expect(parsePageRange("0", 5)).toBeNull();
  });
});

describe("watermark", () => {
  it("draws centred, rotated text over the page", async () => {
    const out = await exportPdf({ base: fixture("chrome-cid.pdf"), ops: [set(wm())] });
    const its = await items(out);
    const w = its.find((i) => i.str === "CONFIDENTIAL")!;
    expect(w).toBeTruthy();
    const [a, b] = w.transform;
    expect(Math.atan2(b!, a!) * 180 / Math.PI).toBeCloseTo(45, 0);
    // Centre of the text ≈ centre of the A4 page.
    const t = Math.PI / 4, len = w.width, h = 48 * 0.7;
    const cx = w.transform[4]! + Math.cos(t) * len / 2 - Math.sin(t) * h / 2;
    const cy = w.transform[5]! + Math.sin(t) * len / 2 + Math.cos(t) * h / 2;
    expect(cx).toBeGreaterThan(595.28 / 2 - 12);
    expect(cx).toBeLessThan(595.28 / 2 + 12);
    expect(cy).toBeGreaterThan(841.89 / 2 - 12);
    expect(cy).toBeLessThan(841.89 / 2 + 12);
    expect(its.some((i) => i.str.includes("Aditi Sharma"))).toBe(true);
  });

  it("reads upright on a rotated page and can go behind the content", async () => {
    const out = await exportPdf({ base: fixture("chrome-cid.pdf"), ops: [{ op: "page.rotate", page: "p1", degrees: 90 }, set(wm({ angle: 0, layer: "under" }))] });
    const w = (await items(out)).find((i) => i.str === "CONFIDENTIAL")!;
    // Page shown rotated 90°: upright text runs up the unrotated page.
    expect(w.transform[0]).toBeCloseTo(0, 3);
    expect(w.transform[1]!).toBeGreaterThan(0);
    // Its stream is drawn first.
    const doc = await PDFDocument.load(out);
    const contents = doc.getPage(0).node.lookup(PDFName.of("Contents"), PDFArray);
    const first = doc.context.lookup(contents.get(0)) as PDFRawStream;
    expect(new TextDecoder("latin1").decode(decodePDFRawStream(first).decode())).toMatch(/BT[\s\S]*Tj/);
  });

  it("tiles across the page, only on the chosen pages", async () => {
    const base = await (async () => {
      const d = await PDFDocument.load(fixture("chrome-cid.pdf"));
      const [copy] = await d.copyPages(d, [0]);
      d.addPage(copy!);
      return d.save();
    })();
    const out = await exportPdf({ base, ops: [set(wm({ layout: "tile", size: 20, text: "DRAFT", pages: "2" }))] });
    expect((await items(out, 1)).filter((i) => i.str === "DRAFT")).toHaveLength(0);
    const tiles = (await items(out, 2)).filter((i) => i.str === "DRAFT");
    expect(tiles.length).toBeGreaterThan(12);
  });

  it("removing the stamp removes the watermark", async () => {
    const out = await exportPdf({ base: fixture("chrome-cid.pdf"), ops: [set(wm()), { op: "annot.add", id: "a", page: "p1", annot: { kind: "highlight", rect: { x: 1, y: 1, w: 5, h: 5 }, color: "#FFE066" } }, set(null)] });
    expect((await items(out)).some((i) => i.str === "CONFIDENTIAL")).toBe(false);
  });

  it("an image watermark is drawn translucent", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDGgAQYGBgAuCAMBp8zDcQAAAABJRU5ErkJggg==";
    const out = await exportPdf({ base: fixture("chrome-cid.pdf"), ops: [set(wm({ text: "", image: png, size: 50 }))] });
    const doc = await PDFDocument.load(out);
    const raw = doc.context.enumerateIndirectObjects().map(([, o]) => o.toString()).join("\n");
    expect(raw).toMatch(/\/ca 0\.3/);
    expect(raw).toMatch(/\/Subtype \/Image/);
  });
});

const hf = (over: Partial<HeaderFooter> = {}): HeaderFooter => ({
  kind: "headerFooter", top: ["", "", ""], bottom: ["", "Page {page} of {pages}", ""], font: "Helvetica", size: 10,
  color: "#3F3F46", margin: 28, startAt: 1, pages: "", ...over,
});
const three = async () => {
  const d = await PDFDocument.load(fixture("chrome-cid.pdf"));
  const copies = await d.copyPages(d, [0, 0]);
  copies.forEach((c) => d.addPage(c));
  return d.save();
};

describe("page numbers, headers and footers", () => {
  it("numbers every page, centred at the bottom", async () => {
    const out = await exportPdf({ base: await three(), ops: [{ op: "stamp.set", key: "headerFooter", stamp: hf() }] });
    for (const n of [1, 2, 3]) {
      const it = (await items(out, n)).find((i) => i.str.startsWith("Page "))!;
      expect(it.str).toBe(`Page ${n} of 3`);
      const centre = it.transform[4]! + it.width / 2;
      expect(Math.abs(centre - 595.28 / 2)).toBeLessThan(1);
      expect(it.transform[5]).toBeCloseTo(28, 0);
    }
  });

  it("fills slots, skips the cover and starts counting at the chosen number", async () => {
    const out = await exportPdf({
      base: await three(), fileName: "Contract.pdf",
      ops: [{ op: "stamp.set", key: "headerFooter", stamp: hf({ top: ["{file}", "", "Printed {date}"], bottom: ["", "", "{page}/{pages}"], pages: "2-", startAt: 1 }) }],
    });
    expect((await items(out, 1)).some((i) => i.str.includes("Contract.pdf"))).toBe(false);
    const p2 = await items(out, 2);
    expect(p2.find((i) => i.str === "Contract.pdf")!.transform[4]).toBeCloseTo(28, 0);
    expect(p2.find((i) => i.str === "1/2")).toBeTruthy();
    expect(p2.some((i) => /^Printed \d{2}\/\d{2}\/\d{4}$/.test(i.str))).toBe(true);
    const right = p2.find((i) => i.str === "1/2")!;
    expect(right.transform[4]! + right.width).toBeCloseTo(595.92 - 28, 0); // chrome-cid.pdf is 595.92 pt wide
    expect((await items(out, 3)).find((i) => i.str === "2/2")).toBeTruthy();
  });

  it("follows the page's rotation", async () => {
    const out = await exportPdf({ base: fixture("chrome-cid.pdf"), ops: [{ op: "page.rotate", page: "p1", degrees: 90 }, { op: "stamp.set", key: "headerFooter", stamp: hf() }] });
    const it = (await items(out)).find((i) => i.str.startsWith("Page"))!;
    expect(it.transform[0]).toBeCloseTo(0, 3);
    expect(it.transform[1]!).toBeGreaterThan(0);
    // Bottom edge as displayed = the page's right edge (x = width - margin).
    expect(it.transform[4]).toBeCloseTo(595.92 - 28, 0);
  });
});

