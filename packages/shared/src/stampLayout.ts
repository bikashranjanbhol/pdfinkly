/**
 * Page-stamp layout shared by the editor preview and the export (no pdf-lib).
 * Positions are in the page's *visual* frame: x right, y UP, origin at the
 * bottom-left of the page as displayed (after its rotation).
 */

/** Parse "1-3, 6, 9-" into 1-based page numbers (all pages when empty). Null when invalid. */
export function parsePageRange(range: string, total: number): Set<number> | null {
  const s = range.trim();
  const out = new Set<number>();
  if (!s) {
    for (let i = 1; i <= total; i++) out.add(i);
    return out;
  }
  for (const part of s.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(p);
    if (!m || (!m[1] && !m[3])) return null;
    const a = m[1] ? Number(m[1]) : 1;
    const b = m[2] ? (m[3] ? Number(m[3]) : total) : a;
    if (a < 1 || b < a) return null;
    for (let i = a; i <= Math.min(b, total); i++) out.add(i);
  }
  return out;
}

/** Centres for a watermark of size (w × h) on a page of (W × H): one, or a staggered grid. */
export function watermarkCentres(layout: "center" | "tile", W: number, H: number, w: number, h: number, angle: number): Array<[number, number]> {
  if (layout === "center") return [[W / 2, H / 2]];
  // Footprint of the rotated stamp, plus breathing room.
  const t = (angle * Math.PI) / 180;
  const fw = Math.abs(w * Math.cos(t)) + Math.abs(h * Math.sin(t));
  const fh = Math.abs(w * Math.sin(t)) + Math.abs(h * Math.cos(t));
  const dx = Math.max(fw * 1.15, 40), dy = Math.max(fh * 1.6, h * 3, 40);
  const out: Array<[number, number]> = [];
  for (let row = 0, y = dy / 2; y < H + dy && out.length < 400; row++, y += dy) {
    for (let x = (row % 2 ? dx : dx / 2) - dx; x < W + dx && out.length < 400; x += dx) out.push([x, y]);
  }
  return out;
}

/** Where to start drawing (bottom-left of the text/image) so its centre lands on (cx, cy), rotated by angle. */
export function startFor(cx: number, cy: number, w: number, h: number, angle: number): [number, number] {
  const t = (angle * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return [cx - (c * w) / 2 + (s * h) / 2, cy - (s * w) / 2 - (c * h) / 2];
}

/** Fill a header/footer slot's tokens for one page. */
export function fillSlot(template: string, v: { page: number; pages: number; date: string; file: string }): string {
  return template
    .replace(/\{page\}/g, String(v.page))
    .replace(/\{pages\}/g, String(v.pages))
    .replace(/\{date\}/g, v.date)
    .replace(/\{file\}/g, v.file);
}

/** Today's date as people in India write it: 15/11/2026. */
export const stampDate = (d = new Date()) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

/**
 * Baseline start of a margin text of width w: slot 0/1/2 = left/centre/right,
 * top or bottom, `margin` from the edges (visual y-up frame).
 */
export function slotStart(slot: number, top: boolean, W: number, H: number, w: number, size: number, margin: number): [number, number] {
  const x = slot === 0 ? margin : slot === 1 ? (W - w) / 2 : W - margin - w;
  const y = top ? H - margin - size * 0.72 : margin;
  return [x, y];
}
