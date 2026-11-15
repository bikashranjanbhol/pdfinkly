import {
  PDFHexString,
  PDFName,
  PDFString,
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  type PDFDocument,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import { OCR_FONT_NAME, type OcrLine } from "./ocrTypes";

export { OCR_FONT_NAME, type OcrLine } from "./ocrTypes";

/**
 * A "glyphless" Type0 font: 2-byte codes are UTF-16 code units, mapped back to
 * Unicode by an identity ToUnicode CMap. It has no glyph outlines because the
 * text it shows is never drawn (render mode 3); it only makes the page's text
 * searchable and copyable — in any script, including Devanagari.
 */
function glyphlessFont(doc: PDFDocument): PDFRef {
  const ctx = doc.context;
  const ranges: string[] = [];
  for (let hi = 0; hi < 256; hi++) {
    if (hi >= 0xd8 && hi <= 0xdf) continue; // surrogates: not mapped
    const h = hi.toString(16).padStart(2, "0").toUpperCase();
    ranges.push(`<${h}00> <${h}FF> <${h}00>`);
  }
  const chunks: string[] = [];
  for (let i = 0; i < ranges.length; i += 100) {
    const part = ranges.slice(i, i + 100);
    chunks.push(`${part.length} beginbfrange\n${part.join("\n")}\nendbfrange`);
  }
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...chunks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  const toUnicode = ctx.register(ctx.flateStream(cmap));
  const descriptor = ctx.register(
    ctx.obj({
      Type: "FontDescriptor",
      FontName: OCR_FONT_NAME,
      Flags: 4,
      FontBBox: [0, -200, 500, 800],
      ItalicAngle: 0,
      Ascent: 800,
      Descent: -200,
      CapHeight: 700,
      StemV: 80,
    }),
  );
  const cidFont = ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "CIDFontType2",
      BaseFont: OCR_FONT_NAME,
      CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
      FontDescriptor: descriptor,
      DW: 500,
      CIDToGIDMap: "Identity",
    }),
  );
  return ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "Type0",
      BaseFont: OCR_FONT_NAME,
      Encoding: "Identity-H",
      DescendantFonts: [cidFont],
      ToUnicode: toUnicode,
    }),
  );
}

const utf16Hex = (s: string) => {
  let out = "";
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, "0");
  return out;
};

/** Cache of the glyphless font per document. */
const fontRefs = new WeakMap<PDFDocument, PDFRef>();

/** Add an invisible, searchable text layer for `lines` to `page`. */
export function drawOcrLayer(doc: PDFDocument, page: PDFPage, lines: OcrLine[]) {
  if (lines.length === 0) return;
  let ref = fontRefs.get(doc);
  if (!ref) {
    ref = glyphlessFont(doc);
    fontRefs.set(doc, ref);
  }
  const key: PDFName = page.node.newFontDictionary("OCR", ref);
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const line of lines) {
    const [dx, dy] = line.dir;
    const len = Math.hypot(dx, dy) || 1;
    const cx = dx / len;
    const cy = dy / len;
    const place = (text: string, x: number, y: number, width: number, size: number) => {
      // Every glyph is 500/1000 em wide; squeeze so the run spans exactly `width`.
      const natural = text.length * 0.5 * size;
      const squeeze = Math.min(1000, Math.max(1, (100 * width) / natural));
      ops.push(
        setFontAndSize(key, round(size)),
        setCharacterSqueeze(round(squeeze)),
        // Text space: x along the baseline direction, y perpendicular (up).
        setTextMatrix(round(cx), round(cy), round(-cy), round(cx), round(x), round(y)),
        showText(PDFHexString.of(utf16Hex(text))),
      );
    };
    line.words.forEach((w, i) => {
      place(w.text, w.x, w.y, w.w, w.size);
      // A space that exactly fills the gap to the next word, so copy/search get word breaks
      // without the space overlapping either word.
      const next = line.words[i + 1];
      if (next) {
        const ex = w.x + cx * w.w;
        const ey = w.y + cy * w.w;
        const gap = (next.x - ex) * cx + (next.y - ey) * cy;
        if (gap > 0.05) place(" ", ex, ey, gap, w.size);
      }
    });
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

const round = (n: number) => Math.round(n * 1000) / 1000;
