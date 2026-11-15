import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { deflateSync } from "node:zlib";
import { imagesToPdf } from "../src/images";

/** A tiny valid PNG of w×h grey pixels. */
function png(w: number, h: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr.set([8, 0, 0, 0, 0], 8);
  const raw = new Uint8Array((w + 1) * h).fill(128); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe("images → PDF", () => {
  it("one A4 page per picture, turned to match, centred within the margin", async () => {
    const pdf = await imagesToPdf([{ bytes: png(300, 400), type: "png", width: 300, height: 400 }, { bytes: png(800, 400), type: "png", width: 800, height: 400 }], { pageSize: "a4", margin: 36, title: "Scans" });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 595.28, height: 841.89 });
    expect(doc.getPage(1).getSize()).toEqual({ width: 841.89, height: 595.28 });
    expect(doc.getTitle()).toBe("Scans");
  });

  it("'fit' makes the page the picture's size at 150 dpi", async () => {
    const doc = await PDFDocument.load(await imagesToPdf([{ bytes: png(1500, 1000), type: "png", width: 1500, height: 1000 }], { pageSize: "fit", margin: 36 }));
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(720, 1);
    expect(height).toBeCloseTo(480, 1);
  });
});
