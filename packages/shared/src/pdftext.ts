import { Encodings, Font, FontNames } from "@pdf-lib/standard-fonts";
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import { removeGlyphs, type FontMetrics, type FontResolver, type RemovalGroup } from "./contentstream";

/* ---------------------------------------------------------- content I/O */

function streamBytes(s: PDFObject | undefined): Uint8Array | null {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFStream) {
    const anyS = s as unknown as { getUnencodedContents?: () => Uint8Array; getContents: () => Uint8Array };
    return anyS.getUnencodedContents ? anyS.getUnencodedContents() : anyS.getContents();
  }
  return null;
}

/** The page's content streams, decoded and joined. */
export function pageContent(page: PDFPage): Uint8Array {
  const ctx = page.doc.context;
  const contents = page.node.get(PDFName.of("Contents"));
  const resolved = contents ? ctx.lookup(contents) : undefined;
  const parts: Uint8Array[] = [];
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) {
      const b = streamBytes(resolved.lookup(i));
      if (b) parts.push(b);
    }
  } else {
    const b = streamBytes(resolved);
    if (b) parts.push(b);
  }
  const nl = new Uint8Array([10]);
  const all = parts.flatMap((p, i) => (i ? [nl, p] : [p]));
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

function setPageContent(doc: PDFDocument, page: PDFPage, bytes: Uint8Array) {
  const ref = doc.context.register(doc.context.flateStream(bytes));
  page.node.set(PDFName.of("Contents"), ref);
}

/* --------------------------------------------------------------- fonts */

const STANDARD: Record<string, FontNames> = {
  Helvetica: FontNames.Helvetica, "Helvetica-Bold": FontNames.HelveticaBold,
  "Helvetica-Oblique": FontNames.HelveticaOblique, "Helvetica-BoldOblique": FontNames.HelveticaBoldOblique,
  "Times-Roman": FontNames.TimesRoman, "Times-Bold": FontNames.TimesRomanBold,
  "Times-Italic": FontNames.TimesRomanItalic, "Times-BoldItalic": FontNames.TimesRomanBoldItalic,
  Courier: FontNames.Courier, "Courier-Bold": FontNames.CourierBold,
  "Courier-Oblique": FontNames.CourierOblique, "Courier-BoldOblique": FontNames.CourierBoldOblique,
  Symbol: FontNames.Symbol, ZapfDingbats: FontNames.ZapfDingbats,
  // Common aliases
  Arial: FontNames.Helvetica, "Arial,Bold": FontNames.HelveticaBold, "Arial-BoldMT": FontNames.HelveticaBold, ArialMT: FontNames.Helvetica,
  TimesNewRoman: FontNames.TimesRoman, "TimesNewRoman,Bold": FontNames.TimesRomanBold, TimesNewRomanPSMT: FontNames.TimesRoman,
  CourierNew: FontNames.Courier,
};

let winAnsiNames: Map<number, string> | undefined;
function winAnsiCodeToName(): Map<number, string> {
  if (!winAnsiNames) {
    winAnsiNames = new Map();
    const mappings = (Encodings.WinAnsi as unknown as { unicodeMappings: Record<number, [number, string]> }).unicodeMappings;
    for (const [code, name] of Object.values(mappings)) winAnsiNames.set(code, name);
  }
  return winAnsiNames;
}

const numAt = (arr: PDFArray, i: number) => {
  const v = arr.lookup(i);
  return v instanceof PDFNumber ? v.asNumber() : 0;
};

function simpleFontMetrics(dict: PDFDict, subtype: string): FontMetrics {
  const widthsArr = dict.lookupMaybe(PDFName.of("Widths"), PDFArray);
  const first = dict.lookupMaybe(PDFName.of("FirstChar"), PDFNumber)?.asNumber() ?? 0;
  const desc = dict.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
  const missing = desc?.lookupMaybe(PDFName.of("MissingWidth"), PDFNumber)?.asNumber() ?? 0;

  let scale = 1;
  if (subtype === "Type3") {
    const fm = dict.lookupMaybe(PDFName.of("FontMatrix"), PDFArray);
    scale = fm ? numAt(fm, 0) * 1000 : 1;
  }

  if (widthsArr) {
    const widths = Array.from({ length: widthsArr.size() }, (_, i) => numAt(widthsArr, i) * scale);
    return { bytesPerCode: 1, vertical: false, width: (c) => widths[c - first] ?? missing };
  }

  // Standard 14 fonts usually omit /Widths: use the built-in AFM metrics.
  const base = (dict.lookupMaybe(PDFName.of("BaseFont"), PDFName)?.decodeText() ?? "").replace(/^[A-Z]{6}\+/, "");
  const std = STANDARD[base] ?? (/bold/i.test(base) ? FontNames.HelveticaBold : FontNames.Helvetica);
  const afm = Font.load(std);
  const names = new Map(winAnsiCodeToName());
  const enc = dict.lookup(PDFName.of("Encoding"));
  if (enc instanceof PDFDict) {
    const diffs = enc.lookupMaybe(PDFName.of("Differences"), PDFArray);
    if (diffs) {
      let code = 0;
      for (let i = 0; i < diffs.size(); i++) {
        const v = diffs.lookup(i);
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) names.set(code++, v.decodeText());
      }
    }
  }
  return {
    bytesPerCode: 1,
    vertical: false,
    width: (c) => {
      const name = names.get(c);
      return (name && afm.getWidthOfGlyph(name)) || missing || 0;
    },
  };
}

function type0Metrics(dict: PDFDict): FontMetrics {
  const enc = dict.lookup(PDFName.of("Encoding"));
  let bytesPerCode: 1 | 2 = 2;
  let vertical = false;
  if (enc instanceof PDFName) {
    vertical = /-V$/.test(enc.decodeText());
  } else if (enc instanceof PDFStream) {
    const text = new TextDecoder("latin1").decode(streamBytes(enc) ?? new Uint8Array());
    const ranges = [...text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)].map((m) => m[1]!);
    const lens = ranges.flatMap((r) => [...r.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1]!.length / 2));
    if (lens.length && lens.every((l) => l === 1)) bytesPerCode = 1;
    vertical = /\/WMode\s+1/.test(text);
  }

  const descendants = dict.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
  const cid = descendants?.lookup(0);
  const widths = new Map<number, number>();
  let dw = 1000;
  if (cid instanceof PDFDict) {
    dw = cid.lookupMaybe(PDFName.of("DW"), PDFNumber)?.asNumber() ?? 1000;
    const w = cid.lookupMaybe(PDFName.of("W"), PDFArray);
    if (w) {
      let i = 0;
      while (i < w.size()) {
        const first = numAt(w, i);
        const next = w.lookup(i + 1);
        if (next instanceof PDFArray) {
          for (let k = 0; k < next.size(); k++) widths.set(first + k, numAt(next, k));
          i += 2;
        } else {
          const last = numAt(w, i + 1);
          const val = numAt(w, i + 2);
          for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, val);
          i += 3;
        }
      }
    }
  }
  return { bytesPerCode, vertical, width: (c) => widths.get(c) ?? dw };
}

/** Resolve a page's /Font resources to glyph metrics. */
export function fontResolverFor(page: PDFPage): FontResolver {
  const resources = page.node.Resources();
  const fontDict = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
  const cache = new Map<string, FontMetrics | null>();
  return (name) => {
    if (cache.has(name)) return cache.get(name)!;
    let metrics: FontMetrics | null = null;
    try {
      const f = fontDict?.lookupMaybe(PDFName.of(name), PDFDict);
      if (f) {
        const subtype = f.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() ?? "Type1";
        metrics = subtype === "Type0" ? type0Metrics(f) : simpleFontMetrics(f, subtype);
      }
    } catch {
      metrics = null;
    }
    cache.set(name, metrics);
    return metrics;
  };
}

/**
 * Remove the original glyphs under each group's rects from the page's own
 * content stream. Returns glyphs removed per group id.
 */
export function removeTextFromPage(doc: PDFDocument, page: PDFPage, groups: RemovalGroup[]): Record<string, number> {
  return removeTextFromPageDetailed(doc, page, groups).removed;
}

/** Like removeTextFromPage, also reporting how many removed glyphs were invisible (OCR text). */
export function removeTextFromPageDetailed(doc: PDFDocument, page: PDFPage, groups: RemovalGroup[]) {
  if (groups.length === 0) return { removed: {} as Record<string, number>, invisible: {} as Record<string, number> };
  const src = pageContent(page);
  const { bytes, removed, invisible } = removeGlyphs(src, fontResolverFor(page), groups);
  if (bytes) setPageContent(doc, page, bytes);
  return { removed, invisible };
}
