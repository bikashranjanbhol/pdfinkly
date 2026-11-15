import type { Face } from "./operations";

export interface FontFlags {
  serif?: boolean;
  mono?: boolean;
  bold?: boolean;
  italic?: boolean;
}

export interface FontMatch {
  face: Face;
  bold: boolean;
  italic: boolean;
  /** Readable family name without the subset prefix, e.g. "Calibri". */
  family: string;
  /** True when the font in the file holds only the characters the document uses. */
  subset: boolean;
}

/** Strip "ABCDEF+" and split "Calibri-BoldItalic" / "Arial,Bold" into family + style. */
export function parseFontName(raw: string): { family: string; style: string; subset: boolean } {
  const subset = /^[A-Z]{6}\+/.test(raw);
  const name = raw.replace(/^[A-Z]{6}\+/, "");
  const m = /^(.*?)(?:[-,](.*))?$/.exec(name)!;
  let family = (m[1] ?? name).replace(/(PSMT|MT|PS)$/, "");
  // "TimesNewRoman" → "Times New Roman", but keep short caps runs like "DejaVu" intact.
  family = family.replace(/([a-z])(?=[A-Z][a-z]{2,})/g, "$1 ").trim();
  return { family: family || name, style: m[2] ?? "", subset };
}

/**
 * Pick the closest available typeface for redrawing text set in `rawName`.
 * Metric-compatible substitutes keep line breaks and widths close to the original:
 * Calibri→Carlito, Cambria→Caladea, Arial/Helvetica→Helvetica, Times→Times, Courier→Courier.
 */
export function matchFont(rawName: string, flags: FontFlags = {}): FontMatch {
  const { family, style, subset } = parseFontName(rawName);
  const all = `${family} ${style}`.toLowerCase();
  const bold = !!flags.bold || /bold|black|heavy|semibold|demi|extrabold|\bsb\b/.test(all);
  const italic = !!flags.italic || /italic|oblique|\bit\b|slanted/.test(all);
  const f = family.toLowerCase().replace(/\s+/g, "");

  let face: Face;
  if (/calibri|carlito/.test(f)) face = "Carlito";
  else if (/cambria|caladea/.test(f)) face = "Caladea";
  else if (flags.mono || /courier|mono|consol|menlo|inconsolata|code|typewriter|lucidaconsole/.test(f)) face = "Courier";
  else if (
    /times|tinos|georgia|garamond|palatino|bookantiqua|bookman|century|baskerville|minion|caslon|didot|bodoni|serif(?!.*sans)|cambria|constantia|liberationserif|charter|merriweather|playfair|lora|libre ?baskerville/.test(f) ||
    (flags.serif && !/sans|arial|helvetica|grotesk|gothic/.test(f))
  ) face = "TimesRoman";
  else face = "Helvetica";

  return { face, bold, italic, family, subset };
}

/** Human label like "Calibri Bold · 11 pt". */
export function describeFont(rawName: string, size: number, flags: FontFlags = {}): string {
  const m = matchFont(rawName, flags);
  const style = [m.bold && "Bold", m.italic && "Italic"].filter(Boolean).join(" ");
  const family = m.family.replace(/\s*(Bold|Italic|Regular|Oblique)\b/gi, "").trim() || m.family;
  return `${family}${style ? ` ${style}` : ""} · ${Math.round(size * 10) / 10} pt`;
}

/** File name (under /fonts) of a bundled face, or null for the PDF standard fonts. */
export function faceFile(face: Face, bold: boolean, italic: boolean): string | null {
  if (face !== "Carlito" && face !== "Caladea") return null;
  return `${face.toLowerCase()}-latin-${bold ? 700 : 400}-${italic ? "italic" : "normal"}.woff`;
}

/** Lines of edited text as they'll be drawn: explicit line breaks, wrapped to the box width. */
export function layoutReplaceLines(text: string, measure: (s: string) => number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (measure(para) <= maxWidth + 0.5) { out.push(para); continue; }
    let line = "";
    for (const w of para.split(/(\s+)/)) {
      const next = line + w;
      if (line.trim() && measure(next.trimEnd()) > maxWidth + 0.5) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}


/** Ascent/descent (fraction of the font size) of each face, for placing text on a baseline in CSS. */
export const FACE_METRICS: Record<Face, { ascent: number; descent: number }> = {
  Helvetica: { ascent: 0.905, descent: 0.212 },
  TimesRoman: { ascent: 0.891, descent: 0.216 },
  Courier: { ascent: 0.833, descent: 0.3 },
  Carlito: { ascent: 0.952, descent: 0.269 },
  Caladea: { ascent: 0.9, descent: 0.25 },
};
