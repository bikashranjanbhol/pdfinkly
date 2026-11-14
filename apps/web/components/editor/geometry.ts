import type { Rect } from "@pdfinkly/shared";

/**
 * Maps between PDF user space (points, origin bottom-left, UNROTATED page) and
 * CSS pixels of the rendered page (origin top-left, page rotated for display).
 * Same math as PDF.js's PageViewport, so the overlay lines up with the canvas.
 */
export interface PageGeom {
  view: [number, number, number, number]; // [x0, y0, x1, y1]
  rotation: number; // total display rotation: 0 | 90 | 180 | 270
  scale: number;
  width: number; // CSS px
  height: number;
}

export function makeGeom(view: [number, number, number, number], rotation: number, scale: number): PageGeom {
  const r = ((rotation % 360) + 360) % 360;
  const w = view[2] - view[0];
  const h = view[3] - view[1];
  const sideways = r % 180 !== 0;
  return { view, rotation: r, scale, width: (sideways ? h : w) * scale, height: (sideways ? w : h) * scale };
}

export function toCss(g: PageGeom, x: number, y: number): [number, number] {
  const [x0, y0, x1, y1] = g.view;
  const s = g.scale;
  switch (g.rotation) {
    case 90: return [s * (y - y0), s * (x - x0)];
    case 180: return [s * (x1 - x), s * (y - y0)];
    case 270: return [s * (y1 - y), s * (x1 - x)];
    default: return [s * (x - x0), s * (y1 - y)];
  }
}

export function toPdf(g: PageGeom, cx: number, cy: number): [number, number] {
  const [x0, y0, x1, y1] = g.view;
  const u = cx / g.scale;
  const v = cy / g.scale;
  switch (g.rotation) {
    case 90: return [x0 + v, y0 + u];
    case 180: return [x1 - u, y0 + v];
    case 270: return [x1 - v, y1 - u];
    default: return [x0 + u, y1 - v];
  }
}

export function rectToCss(g: PageGeom, r: Rect) {
  const [ax, ay] = toCss(g, r.x, r.y);
  const [bx, by] = toCss(g, r.x + r.w, r.y + r.h);
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

export function cssToRect(g: PageGeom, left: number, top: number, width: number, height: number): Rect {
  const [ax, ay] = toPdf(g, left, top);
  const [bx, by] = toPdf(g, left + width, top + height);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

export const round = (n: number) => Math.round(n * 100) / 100;
