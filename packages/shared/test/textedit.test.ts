import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { parseContent, removeGlyphs } from "../src/contentstream";
import { removeTextFromPage } from "../src/pdftext";

type Item = { str: string; x: number; y: number; w: number; h: number };

async function textItems(bytes: Uint8Array, pageNo = 1): Promise<Item[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false });
  const doc = await task.promise;
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent();
  const items = (tc.items as Array<{ str: string; transform: number[]; width: number; height: number }>)
    .filter((i) => i.str.trim())
    .map((i) => ({ str: i.str, x: i.transform[4]!, y: i.transform[5]!, w: i.width, h: i.height }));
  await task.destroy();
  return items;
}

const rectOf = (i: Item) => ({ x: i.x, y: i.y - i.h * 0.25, w: i.w, h: i.h * 1.2 });

describe("content stream parser", () => {
  it("reads strings with escapes, nested parens, hex and arrays", () => {
    const src = new TextEncoder().encode("BT /F1 12 Tf (a\\(b\\) (nested) \\101\\n) Tj [<0041> -250 (B)] TJ ET");
    const ops = parseContent(src);
    expect(ops.map((o) => o.op)).toEqual(["BT", "Tf", "Tj", "TJ", "ET"]);
    const s = ops[2]!.args[0]!;
    expect(s.t === "str" && new TextDecoder().decode(s.v)).toBe("a(b) (nested) A\n");
    const arr = ops[3]!.args[0]!;
    expect(arr.t === "arr" && arr.v.map((p) => p.t)).toEqual(["str", "num", "str"]);
  });

  it("skips inline images without misreading their binary data as operators", () => {
    const src = new Uint8Array([
      ...new TextEncoder().encode("q BI /W 2 /H 1 /BPC 8 /CS /G ID "),
      0x54, 0x6a, 0x29, // bytes that look like "Tj)"
      ...new TextEncoder().encode(" EI Q BT ET"),
    ]);
    expect(parseContent(src).map((o) => o.op)).toEqual(["q", "BI", "Q", "BT", "ET"]);
  });
});

describe("removing text", () => {
  it("removes one word from a standard-font line and leaves the rest in place", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 200]);
    const f = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("Hello World", { x: 40, y: 120, size: 20, font: f, color: rgb(0, 0, 0) });
    page.drawText("Keep me", { x: 40, y: 80, size: 14, font: f });
    const before = await textItems(await doc.save());

    const hello = f.widthOfTextAtSize("Hello ", 20);
    const world = { x: 40 + hello, y: 115, w: f.widthOfTextAtSize("World", 20), h: 24 };
    const removed = removeTextFromPage(doc, page, [{ id: "w", rects: [world] }]);
    expect(removed.w).toBe(5);

    const after = await textItems(await doc.save());
    const all = after.map((i) => i.str).join("|");
    expect(all).not.toContain("World");
    expect(all).toContain("Hello");
    const keep = (items: Item[]) => items.find((i) => i.str.includes("Keep"))!;
    expect(keep(after).x).toBeCloseTo(keep(before).x, 3);
    expect(keep(after).y).toBeCloseTo(keep(before).y, 3);
  });

  it("removes a whole paragraph from a Chrome PDF (Type0, Identity-H) without moving anything else", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/chrome-cid.pdf", import.meta.url)));
    const before = await textItems(bytes);
    const target = before.filter((i) => Math.abs(i.y - 719.13) < 1 || Math.abs(i.y - 705.63) < 1);
    expect(target.map((i) => i.str).join("")).toContain("Product designer");

    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    const removed = removeTextFromPage(doc, page, [{ id: "p", rects: target.map(rectOf) }]);
    const expected = target.reduce((s, i) => s + i.str.replace(/\s/g, "").length, 0);
    expect(removed.p).toBeGreaterThan(expected * 0.9);

    const after = await textItems(await doc.save());
    const text = after.map((i) => i.str).join(" ");
    expect(text).not.toMatch(/Product designer|payments dashboard|healthcare/);
    // Everything that wasn't targeted is still there, at the same position.
    for (const it of before.filter((i) => !target.includes(i))) {
      const match = after.find((a) => a.str === it.str && Math.abs(a.x - it.x) < 0.01 && Math.abs(a.y - it.y) < 0.01);
      expect(match, `${it.str} moved or vanished`).toBeTruthy();
    }
  });

  it("removes the middle of a TJ run but keeps the following glyphs exactly where they were", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/chrome-cid.pdf", import.meta.url)));
    const before = await textItems(bytes);
    // "Phone:" sits on the same line as the e-mail; remove only the e-mail address.
    const email = before.find((i) => i.str.includes("@example.com"))!;
    const phone = before.find((i) => i.str.startsWith("+91"))!;
    const doc = await PDFDocument.load(bytes);
    removeTextFromPage(doc, doc.getPage(0), [{ id: "e", rects: [rectOf(email)] }]);
    const after = await textItems(await doc.save());
    expect(after.map((i) => i.str).join(" ")).not.toContain("example.com");
    const phoneAfter = after.find((i) => i.str.startsWith("+91"))!;
    expect(phoneAfter.x).toBeCloseTo(phone.x, 2);
    expect(phoneAfter.y).toBeCloseTo(phone.y, 2);
  });

  it("reports zero when the text isn't in the page's own content", () => {
    const src = new TextEncoder().encode("q /Fm0 Do Q");
    const { bytes, removed } = removeGlyphs(src, () => null, [{ id: "x", rects: [{ x: 0, y: 0, w: 999, h: 999 }] }]);
    expect(bytes).toBeNull();
    expect(removed.x).toBe(0);
  });
});

describe("exporting edited text", () => {
  const loadFont = async (file: string) => {
    const pkg = file.startsWith("carlito") ? "@fontsource/carlito" : "@fontsource/caladea";
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const dir = req.resolve(`${pkg}/package.json`).replace(/package\.json$/, "");
    return new Uint8Array(readFileSync(`${dir}files/${file}`));
  };

  it("replaces a paragraph: old text gone, new text in Carlito at the same baseline, rest untouched", async () => {
    const { exportPdf } = await import("../src/export");
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/chrome-cid.pdf", import.meta.url)));
    const before = await textItems(bytes);
    const target = before.filter((i) => Math.abs(i.y - 719.13) < 1 || Math.abs(i.y - 705.63) < 1);
    const top = Math.max(...target.map((i) => i.y + i.h * 0.95));
    const left = Math.min(...target.map((i) => i.x));
    const right = Math.max(...target.map((i) => i.x + i.w));
    const bottom = Math.min(...target.map((i) => i.y - i.h * 0.25));
    const warnings: string[] = [];
    const out = await exportPdf({
      base: bytes,
      loadFont,
      onWarning: (w) => warnings.push(w),
      ops: [{
        op: "annot.add", id: "e1", page: "p1",
        annot: {
          kind: "replace",
          rect: { x: left, y: bottom, w: right - left, h: top - bottom },
          cover: target.map(rectOf),
          text: "Senior product designer with 7 years of experience.\nLed the payments redesign.",
          original: target.map((i) => i.str).join(""),
          face: "Carlito", bold: false, italic: false, size: 10.99, color: "#1F2937", bg: "#FFFFFF",
          lineHeight: 13.5, firstBaseline: top - 719.13, srcFont: "CAAAAA+Carlito-Regular",
        },
      }],
    });
    expect(warnings).toEqual([]);
    const after = await textItems(out);
    const text = after.map((i) => i.str).join(" ");
    expect(text).toContain("Senior product designer with 7 years of experience.");
    expect(text).toContain("Led the payments redesign.");
    expect(text).not.toMatch(/healthcare|40,000 merchants/);
    const first = after.find((i) => i.str.startsWith("Senior"))!;
    expect(first.y).toBeCloseTo(719.13, 1);
    expect(first.x).toBeCloseTo(left, 1);
    for (const it of before.filter((i) => !target.includes(i))) {
      expect(after.some((a) => a.str === it.str && Math.abs(a.x - it.x) < 0.01 && Math.abs(a.y - it.y) < 0.01), it.str).toBe(true);
    }
  });

  it("covers instead (and warns) when the original text can't be found", async () => {
    const { exportPdf } = await import("../src/export");
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const warnings: string[] = [];
    const out = await exportPdf({
      base: await doc.save(),
      onWarning: (w) => warnings.push(w),
      ops: [{ op: "annot.add", id: "e2", page: "p1", annot: {
        kind: "replace", rect: { x: 20, y: 200, w: 200, h: 20 }, cover: [{ x: 20, y: 200, w: 200, h: 20 }],
        text: "New", original: "Ghost text", face: "Helvetica", bold: true, italic: false, size: 12,
        color: "#000000", bg: "#FFFFFF", lineHeight: 14, firstBaseline: 14, srcFont: "Helvetica-Bold",
      } }],
    });
    expect(warnings.length).toBe(1);
    expect((await textItems(out)).map((i) => i.str).join("")).toContain("New");
  });
});

describe("font matching", () => {
  it("maps real font names to the closest bundled face", async () => {
    const { matchFont, describeFont } = await import("../src/fonts");
    expect(matchFont("BAAAAA+Carlito-Bold")).toMatchObject({ face: "Carlito", bold: true, italic: false, subset: true });
    expect(matchFont("ABCDEF+Calibri-BoldItalic")).toMatchObject({ face: "Carlito", bold: true, italic: true, family: "Calibri" });
    expect(matchFont("Cambria")).toMatchObject({ face: "Caladea" });
    expect(matchFont("Arial-BoldMT")).toMatchObject({ face: "Helvetica", bold: true, family: "Arial" });
    expect(matchFont("TimesNewRomanPSMT")).toMatchObject({ face: "TimesRoman", family: "Times New Roman" });
    expect(matchFont("DAAAAA+DejaVuSerif", { serif: true })).toMatchObject({ face: "TimesRoman" });
    expect(matchFont("EAAAAA+DejaVuSansMono", { mono: true })).toMatchObject({ face: "Courier" });
    expect(matchFont("AAAAAA+Poppins-Bold")).toMatchObject({ face: "Helvetica", bold: true });
    expect(describeFont("BAAAAA+Carlito-Bold", 10.99)).toBe("Carlito Bold · 11 pt");
    expect(describeFont("DAAAAA+DejaVuSansMono", 9, { mono: true })).toBe("DejaVu Sans Mono · 9 pt");
    expect(matchFont("LiberationSerif").family).toBe("Liberation Serif");
  });
});
