import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import { applyCompression, planCompression } from "../src/compress";

const fixture = (f: string) => new Uint8Array(readFileSync(path.join(__dirname, "fixtures", f)));

describe("compression", () => {
  it("plans the scan image with its displayed size, and skips small images", async () => {
    const jobs = await planCompression(fixture("scan-en.pdf"));
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j.width).toBeGreaterThan(1500);
    expect(j.shownWidth).toBeCloseTo(595.28, 0);
    expect(j.bytes).toBeGreaterThan(50_000);
    expect((await PDFDocument.load(j.pdf)).getPage(0).getSize()).toEqual({ width: j.width, height: j.height });
    expect(await planCompression(fixture("chrome-cid.pdf"))).toEqual([]);
  });

  it("swaps in the smaller image, keeps the page, drops metadata", async () => {
    const base = fixture("scan-en.pdf");
    const [job] = await planCompression(base);
    // A tiny valid JPEG stands in for what the browser would encode.
    const jpeg = Uint8Array.from(Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64"));
    const out = await applyCompression(base, [{ key: job!.key, width: 1, height: 1, data: jpeg }]);
    expect(out.length).toBeLessThan(base.length / 4);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    const [num, gen] = job!.key.split(":").map(Number);
    const img = doc.context.lookup(PDFRef.of(num!, gen!)) as PDFRawStream;
    expect(img.dict.get(PDFName.of("Filter"))?.toString()).toBe("/DCTDecode");
    expect(doc.catalog.get(PDFName.of("Metadata"))).toBeUndefined();
  });
});
