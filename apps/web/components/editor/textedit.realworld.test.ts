import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchFont } from "@pdfinkly/shared";
import { exportPdf } from "@pdfinkly/shared/export";
import { textBlocks, type TextBlock } from "./textBlocks";

/**
 * End-to-end check of "Edit text" on PDFs from different producers: detect
 * blocks the way the editor does, edit each block in turn, export, and read the
 * result back with PDF.js.
 */
const FIXTURES = path.join(__dirname, "../../../../packages/shared/test/fixtures");
const require = createRequire(import.meta.url);
const loadFont = async (file: string) => {
  const pkg = file.startsWith("carlito") ? "@fontsource/carlito" : "@fontsource/caladea";
  return new Uint8Array(readFileSync(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "files", file)));
};

type Item = { str: string; x: number; y: number };

async function open(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), fontExtraProperties: true, disableFontFace: true, useSystemFonts: false });
  const doc = await task.promise;
  return { page: await doc.getPage(1), close: () => task.destroy() };
}

async function items(bytes: Uint8Array): Promise<Item[]> {
  const { page, close } = await open(bytes);
  const tc = await page.getTextContent();
  const out = (tc.items as Array<{ str: string; transform: number[] }>)
    .filter((i) => i.str.trim())
    .map((i) => ({ str: i.str, x: i.transform[4]!, y: i.transform[5]! }));
  await close();
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, "");

function annotFor(b: TextBlock, text: string) {
  const m = matchFont(b.font.raw, b.font);
  return {
    kind: "replace" as const, rect: b.rect, cover: b.cover, text, original: b.text,
    face: m.face, bold: m.bold, italic: m.italic, size: b.size, color: "#000000", bg: "#FFFFFF",
    lineHeight: b.lineHeight, firstBaseline: b.firstBaseline, srcFont: b.font.raw,
  };
}

describe.each([
  ["chrome-cid.pdf", "Chrome (Type0 / Identity-H)"],
  ["letter-libreoffice.pdf", "LibreOffice (simple TrueType)"],
  ["report-pdflatex.pdf", "pdfLaTeX (Type1, kerned TJ)"],
  ["resume-wkhtmltopdf.pdf", "wkhtmltopdf (Type0, Qt)"],
])("%s — %s", (file) => {
  it("detects blocks with real font names, and every block can be replaced cleanly", async () => {
    const bytes = new Uint8Array(readFileSync(path.join(FIXTURES, file)));
    const { page, close } = await open(bytes);
    const blocks = await textBlocks(page);
    await close();
    expect(blocks.length).toBeGreaterThan(2);
    for (const b of blocks) expect(b.font.raw, "font name resolved").not.toMatch(/^g_d\d+_f\d+$/);

    const before = await items(bytes);
    for (const b of blocks) {
      const marker = `EDITED ${b.key.replace(/[^0-9]/g, "")}`;
      const warnings: string[] = [];
      const out = await exportPdf({
        base: bytes, loadFont, onWarning: (w) => warnings.push(w),
        ops: [{ op: "annot.add", id: "e", page: "p1", annot: annotFor(b, marker) }],
      });
      expect(warnings, `${file}: "${b.text.slice(0, 40)}" should be removable`).toEqual([]);
      const after = await items(out);
      const afterText = norm(after.map((i) => i.str).join(""));
      expect(afterText).toContain(norm(marker));
      // The block's own text is gone…
      const own = norm(b.text);
      if (own.length >= 6) expect(afterText.includes(own), `"${b.text.slice(0, 40)}" still present`).toBe(false);
      // …and every item outside the block's lines is still there, unmoved.
      const inBlock = (i: Item) => b.cover.some((r) => i.x >= r.x - 1 && i.x <= r.x + r.w + 1 && i.y >= r.y - 1 && i.y <= r.y + r.h + 1);
      for (const it of before.filter((i) => !inBlock(i))) {
        const kept = after.some((a) => a.str === it.str && Math.abs(a.x - it.x) < 0.05 && Math.abs(a.y - it.y) < 0.05);
        expect(kept, `${file}: "${it.str}" moved or vanished when editing "${b.text.slice(0, 30)}"`).toBe(true);
      }
    }
  }, 60_000);
});
