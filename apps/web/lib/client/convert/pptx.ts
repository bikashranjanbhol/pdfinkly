"use client";

import type { PageLayout } from "./layout";

const inch = (pt: number) => pt / 72;
const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

/**
 * PowerPoint deck: one slide per page, the page without its text as the
 * background (so drawings, images and colours look the same) and every
 * paragraph as an editable text box in its place.
 */
export async function layoutsToPptx(pages: Array<{ layout: PageLayout; background: { data: Uint8Array; type: "png" | "jpg" } }>, title: string): Promise<Uint8Array> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  const first = pages[0]?.layout ?? { width: 960, height: 540 };
  pptx.defineLayout({ name: "PDF", width: inch(first.width), height: inch(first.height) });
  pptx.layout = "PDF";
  pptx.title = title;
  pptx.company = "PDFInkly";

  for (const { layout, background } of pages) {
    const slide = pptx.addSlide();
    // Pages of another size are scaled to the deck's.
    const k = Math.min(first.width / layout.width, first.height / layout.height);
    slide.background = { data: `image/${background.type === "png" ? "png" : "jpeg"};base64,${b64(background.data)}` };
    for (const p of layout.paras) {
      const multi = p.lines > 1;
      slide.addText(
        p.runs.map((r) => ({ text: r.text.replace(/\t/g, "    "), options: { fontFace: r.family, fontSize: r.size * k, bold: r.bold, italic: r.italic, color: r.color.replace("#", "") } })),
        {
          x: inch(p.x * k), y: inch(p.top * k), w: inch((p.width + p.size * (multi ? 0.6 : 2)) * k), h: inch((p.bottom - p.top) * k),
          margin: 0, valign: "top", fit: "none", wrap: multi, ...(multi && p.lineGap ? { lineSpacing: p.lineGap * k } : {}),
        },
      );
    }
  }
  const out = await pptx.write({ outputType: "uint8array" });
  return out as Uint8Array;
}
