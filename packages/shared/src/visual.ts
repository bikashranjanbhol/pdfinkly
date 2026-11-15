import type { Rect } from "./operations";

/**
 * Map a point given in "visual" coordinates (u to the right, v downward, from
 * the visual top-left of `rect` as seen with total rotation `rot`) into the
 * page's unrotated PDF space.
 */
export function visualToPage(rect: Rect, rot: number, u: number, v: number): [number, number] {
  const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.w, y1 = rect.y + rect.h;
  switch (((rot % 360) + 360) % 360) {
    case 90: return [x0 + v, y0 + u];
    case 180: return [x1 - u, y0 + v];
    case 270: return [x1 - v, y1 - u];
    default: return [x0 + u, y1 - v];
  }
}

/** Width and height of `rect` as seen on screen with rotation `rot`. */
export const visualSize = (rect: Rect, rot: number) =>
  rot % 180 === 0 ? { w: rect.w, h: rect.h } : { w: rect.h, h: rect.w };

/**
 * Rotation (0/90/180/270, counter-clockwise in PDF space) of text whose
 * direction vector is (dx, dy) and whose "up" vector is (ux, uy), or null when
 * the text isn't axis-aligned and upright in one of the four orientations.
 */
export function textRotation(dx: number, dy: number, ux: number, uy: number, tol = 0.02): 0 | 90 | 180 | 270 | null {
  const n = Math.hypot(dx, dy), m = Math.hypot(ux, uy);
  if (n === 0 || m === 0) return null;
  const [a, b, c, d] = [dx / n, dy / n, ux / m, uy / m];
  const near = (p: number, q: number) => Math.abs(p - q) < tol;
  if (near(a, 1) && near(b, 0) && near(c, 0) && near(d, 1)) return 0;
  if (near(a, 0) && near(b, 1) && near(c, -1) && near(d, 0)) return 90;
  if (near(a, -1) && near(b, 0) && near(c, 0) && near(d, -1)) return 180;
  if (near(a, 0) && near(b, -1) && near(c, 1) && near(d, 0)) return 270;
  return null;
}

/** Rotate a point by -rot (into the frame where text with rotation `rot` runs left to right, y up). */
export function toTextFrame(rot: number, x: number, y: number): [number, number] {
  switch (((rot % 360) + 360) % 360) {
    case 90: return [y, -x];
    case 180: return [-x, -y];
    case 270: return [-y, x];
    default: return [x, y];
  }
}

/** Inverse of toTextFrame. */
export function fromTextFrame(rot: number, X: number, Y: number): [number, number] {
  return toTextFrame(360 - (((rot % 360) + 360) % 360), X, Y);
}

/** Map an axis-aligned rect from a text frame back to PDF space. */
export function rectFromTextFrame(rot: number, r: Rect): Rect {
  const [ax, ay] = fromTextFrame(rot, r.x, r.y);
  const [bx, by] = fromTextFrame(rot, r.x + r.w, r.y + r.h);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}
